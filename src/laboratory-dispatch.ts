import { z } from 'zod';
import { createHash } from 'node:crypto';
import { scoped, type Database, type Queryable } from './database.js';
import type { Channel } from './store.js';
import type { Config } from './config.js';
import { AGENT_OUTPUT_JSON_SCHEMA, LeadStateSchema } from './domain.js';
import { FINANCIAL_OUTPUT_JSON_SCHEMA } from './financial-reply.js';
import { retrieveKnowledge } from './knowledge.js';
import { CampaignAdmissionSchema, CampaignAdmissionMarkerSchema } from './campaign-admission.spec.js';
import { LaboratoryDispatchInputSchema, type LaboratoryDispatchResult, type LaboratoryDispatchSpec, type LaboratoryDispatchDataSchema } from './laboratory-dispatch.spec.js';

// The brand advisory lock must be acquired in a PREVIOUS statement by scoped().
// Dependency edges enforce job -> conversation -> candidate row-lock order.
const headerSql = `WITH locked_job AS MATERIALIZED (
  SELECT j.* FROM sdr.jobs j WHERE j.tenant_id=$1 AND j.brand_id=$2 AND j.id=$3 FOR UPDATE OF j
), locked_conversation AS MATERIALIZED (
  SELECT c.* FROM sdr.conversations c JOIN locked_job j ON c.id=j.conversation_id
  WHERE c.tenant_id=$1 AND c.brand_id=$2 FOR UPDATE OF c
), locked_candidate AS MATERIALIZED (
  SELECT p.* FROM sdr.candidates p JOIN locked_job j ON p.id=j.candidate_id
  JOIN locked_conversation c ON c.id=j.conversation_id
  WHERE p.tenant_id=$1 AND p.brand_id=$2 FOR UPDATE OF p
)
SELECT (SELECT to_jsonb(j) FROM locked_job j) AS job,
  (SELECT to_jsonb(c) FROM locked_conversation c) AS conversation,
  (SELECT to_jsonb(p) FROM locked_candidate p) AS candidate,
  (SELECT jsonb_build_object('snapshot',v.snapshot,'content_hash',v.content_hash,'model',v.model)
    FROM sdr.versions v JOIN locked_job j ON v.id=j.version_id JOIN locked_candidate p ON p.id=j.candidate_id
    WHERE v.tenant_id=$1 AND v.brand_id=$2) AS version,
  (SELECT kind FROM sdr.channels WHERE tenant_id=$1 AND brand_id=$2 AND phone_number_id=$4) AS channel_kind,
  COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.provider_timestamp)
    FROM (SELECT m.id,m.actor,m.text,m.type,m.provider_timestamp FROM sdr.messages m JOIN locked_candidate p ON p.id=m.candidate_id
      WHERE m.tenant_id=$1 AND m.brand_id=$2 ORDER BY m.provider_timestamp DESC,m.created_at DESC LIMIT 24) m),'[]'::jsonb) AS messages,
  EXISTS(SELECT 1 FROM (SELECT m.type,m.text FROM sdr.messages m JOIN locked_conversation c ON c.id=m.conversation_id
    WHERE m.tenant_id=$1 AND m.brand_id=$2 AND m.actor='candidate' ORDER BY m.provider_timestamp DESC LIMIT 24) recent
    WHERE type='audio' AND text='') AS has_audio,
  (SELECT jsonb_build_object('type',m.type,'actor',m.actor,'candidate_id',m.candidate_id,'conversation_id',m.conversation_id)
    FROM sdr.messages m JOIN locked_job j ON m.id=j.trigger_message_id WHERE m.tenant_id=$1 AND m.brand_id=$2) AS trigger`;

const headerSchema = z.object({
  job: z.object({ id: z.string(), candidate_id: z.string(), conversation_id: z.string(), version_id: z.string(), trigger_message_id: z.string(), context: z.unknown(),
    attempts: z.number().int(), context_version: z.number().int(), epoch: z.number().int(), state: z.string(), deadline: z.coerce.date() }),
  conversation: z.object({ id: z.string(), candidate_id: z.string(), phone_number_id: z.string(), epoch: z.number().int(), state: z.string() }),
  candidate: z.object({ id: z.string(), revision: z.number().int(), lead_state: z.unknown() }),
  version: z.object({ snapshot: z.unknown(), content_hash: z.string(), model: z.string() }),
  channel_kind: z.string().nullable(), has_audio: z.boolean(),
  trigger: z.object({ type: z.string(), actor: z.string(), candidate_id: z.string(), conversation_id: z.string() }),
  messages: z.array(z.object({ id: z.string(), actor: z.string(), text: z.string(), type: z.string(), provider_timestamp: z.string() })),
});
type Header = z.infer<typeof headerSchema>;
type PauseCode = Extract<z.infer<typeof LaboratoryDispatchDataSchema>, { kind: 'paused' }>['reason'];
// Signals a rollback, never a successfully committed context with no reservation.
class ExpiredPreparation extends Error {}

/** Scoped laboratory coordinator. Claim, transport and conditional ACK stay outside.
 * A ready body leaves this port only after Database.transaction has committed. */
export class LaboratoryDispatch implements LaboratoryDispatchSpec {
  constructor(private db: Database, private channel: Channel,
    private config: Pick<Config, 'PUBLIC_API_URL' | 'LAB_BUDGET_GATE_ID' | 'LAB_BUDGET_LIMIT_MICRO_USD'>,
    private now: () => Date = () => new Date(), private clock: () => number = () => performance.now()) {}
  async execute(raw: unknown): Promise<LaboratoryDispatchResult> {
    const input = LaboratoryDispatchInputSchema.safeParse(raw);
    if (!input.success) return { success: false, error: { code: 'INVALID_INPUT' } };
    if (this.channel.kind !== 'laboratory') return { success: false, error: { code: 'NOT_LABORATORY' } };
    try {
      const started = this.clock();
      return await scoped(this.db, this.channel, async tx => {
        const s = [this.channel.tenantId, this.channel.brandId];
        const row = (await tx.query(headerSql, [...s, input.data.jobId, this.channel.phoneNumberId])).rows[0];
        if (row.job === null) return { success: false, error: { code: 'JOB_NOT_FOUND' } };
        const locked = headerSchema.pick({ job: true, conversation: true, candidate: true }).parse(row);
        if (locked.job.state !== 'working' || locked.job.attempts !== input.data.attempt
          || locked.job.context_version !== input.data.contextVersion || locked.job.epoch !== input.data.epoch
          || locked.job.version_id !== input.data.versionId || locked.candidate.revision !== locked.job.context_version
          || locked.conversation.epoch !== locked.job.epoch || locked.conversation.state !== 'automatic'
          || locked.job.deadline <= this.now()) return { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } };
        const preflight = headerSchema.omit({ version: true, messages: true }).parse(row);
        if (preflight.channel_kind !== 'laboratory' || preflight.conversation.phone_number_id !== this.channel.phoneNumberId
          || preflight.conversation.candidate_id !== preflight.candidate.id || preflight.trigger.actor !== 'candidate'
          || preflight.trigger.candidate_id !== preflight.job.candidate_id || preflight.trigger.conversation_id !== preflight.job.conversation_id) {
          return { success: false, error: { code: 'INCONSISTENT_SNAPSHOT' } };
        }
        if (preflight.has_audio) return this.capability(tx, preflight.job, 'AUDIO_REQUIRES_TEXT');
        if (['unsupported', 'image', 'document'].includes(preflight.trigger.type)) return this.capability(tx, preflight.job, 'UNSUPPORTED_MESSAGE');
        const loaded = headerSchema.parse(row);
        const { job, candidate, version, messages } = loaded;
        // Runtime import keeps the currently Engine-owned contract single-sourced.
        // execute runs only after module initialization, avoiding a top-level TDZ cycle.
        const { SnapshotSchema } = await import('./engine.js');
        const { snapshotHash } = await import('./versioning.js');
        const snapshot = SnapshotSchema.parse(version.snapshot), lead = LeadStateSchema.parse(candidate.lead_state);
        if (snapshot.tenant.tenantId !== this.channel.tenantId || snapshot.tenant.brandId !== this.channel.brandId
          || lead.tenantId !== this.channel.tenantId || lead.brandId !== this.channel.brandId || lead.leadId !== candidate.id
          || snapshotHash(snapshot) !== version.content_hash || version.model !== snapshot.model) {
          return { success: false, error: { code: 'INCONSISTENT_SNAPSHOT' } };
        }
        const question = messages.filter(m => m.actor === 'candidate').slice(-4).map(m => m.text).join(' ');
        const retrieval = await retrieveKnowledge(tx, this.channel, job.version_id, question, undefined, this.now().toISOString());
        if (retrieval.mode === 'unavailable') return { success: false, error: { code: 'KNOWLEDGE_UNAVAILABLE' } };
        const context = { tenant: snapshot.tenant, lead, messages: messages.map(m => ({ id: m.id,
          role: m.actor === 'candidate' ? 'user' : m.actor === 'human' ? 'operator' : 'assistant', text: m.text, type: m.type,
          createdAt: new Date(m.provider_timestamp).toISOString() })), sources: retrieval.sources,
          excludedSources: retrieval.excludedSources, retrieval: retrieval.mode, contextVersion: job.context_version };
        const campaignMarker = job.context && typeof job.context === 'object' && 'campaignAdmission' in job.context ? job.context.campaignAdmission : undefined;
        // Admission is private operational evidence, never part of the model payload.
        const operationalContext = { ...context, ...(campaignMarker !== undefined ? { campaignAdmission: campaignMarker } : {}) };
        const body = JSON.stringify({ jobId: job.id, contextVersion: job.context_version, configVersion: job.version_id,
          model: snapshot.model, instructions: snapshot.prompt, context,
          outputSchema: snapshot.outputContract === 'financial-v2' ? FINANCIAL_OUTPUT_JSON_SCHEMA : AGENT_OUTPUT_JSON_SCHEMA,
          callbackUrl: this.config.PUBLIC_API_URL.replace(/\/$/, '') + '/internal/n8n/jobs/' + encodeURIComponent(job.id) + '/complete' });
        this.requireLive(job);
        const gateId = this.config.LAB_BUDGET_GATE_ID;
        if (!gateId || !Number.isSafeInteger(this.config.LAB_BUDGET_LIMIT_MICRO_USD) || this.config.LAB_BUDGET_LIMIT_MICRO_USD! <= 0) {
          return this.pause(tx, loaded, context, 'LAB_BUDGET_NOT_CONFIGURED');
        }
        if (this.channel.tenantId !== 'cognita-homologacao' || this.channel.brandId !== 'sapore') {
          return this.pause(tx, loaded, context, 'LAB_BUDGET_SCOPE_MISMATCH');
        }
        const reservationId = 'lab-budget:' + createHash('sha256').update(`${gateId}:${job.id}:${job.attempts}`).digest('hex');
        const budget = (await tx.query<{ duplicate: boolean; total: string; admissions: { id: string; conversationId: string; detail: unknown; createdAt: string; actorAllowed: boolean }[] }>(`SELECT
          EXISTS(SELECT 1 FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2
            AND type='lab_model_budget_reserved' AND detail->>'jobId'=$3) AS duplicate,
          COALESCE((SELECT sum((detail->>'costMicroUsd')::bigint) FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2
            AND type='lab_model_budget_reserved' AND detail->>'gateId'=$4),0)::text AS total,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'conversationId',e.conversation_id,'detail',e.detail,'createdAt',e.created_at,'actorAllowed',
            EXISTS(SELECT 1 FROM sdr.lab_sessions l JOIN sdr.memberships m ON m.tenant_id=l.tenant_id AND m.brand_id=l.brand_id
              AND m.user_id=l.owner_user_id AND m.role='admin' AND m.active
              WHERE l.tenant_id=$1 AND l.brand_id=$2 AND l.id=$5 AND l.candidate_id=$6 AND l.version_id=$7
                AND l.owner_user_id=e.detail->>'actorUserId')))
            FROM sdr.events e WHERE e.tenant_id=$1 AND e.brand_id=$2 AND e.type='lab_campaign_admitted'
              AND (e.id='lab-campaign:'||$3 OR e.detail->>'jobId'=$3)),'[]'::jsonb) AS admissions`,
          [...s, job.id, gateId, job.conversation_id, job.candidate_id, job.version_id])).rows[0];
        if (budget.duplicate) return { success: true, data: { kind: 'ignored', reason: 'ALREADY_RESERVED' } };
        let ceiling: number | undefined;
        if (campaignMarker !== undefined || budget.admissions.length > 0) {
          const event = budget.admissions[0], admission = CampaignAdmissionSchema.safeParse(event?.detail), marker = CampaignAdmissionMarkerSchema.safeParse(campaignMarker);
          if (budget.admissions.length !== 1 || !event || !admission.success || !marker.success || !event.actorAllowed
            || event.id !== 'lab-campaign:' + job.id || event.conversationId !== job.conversation_id || marker.data.id !== event.id
            || marker.data.contentHash !== createHash('sha256').update(JSON.stringify(admission.data)).digest('hex')) {
            return this.pause(tx, loaded, context, 'CAMPAIGN_ADMISSION_INVALID');
          }
          const a = admission.data, admittedAt = new Date(event.createdAt).getTime();
          if (a.tenantId !== this.channel.tenantId || a.brandId !== this.channel.brandId || a.sessionId !== job.conversation_id
            || a.jobId !== job.id || a.candidateId !== job.candidate_id || a.contextVersion !== job.context_version || a.epoch !== job.epoch
            || job.trigger_message_id !== a.sessionId + ':' + a.requestId || a.target.versionId !== job.version_id
            || a.target.contentHash !== version.content_hash || a.target.model !== snapshot.model
            || a.gateId !== gateId || a.limitMicroUsd !== this.config.LAB_BUDGET_LIMIT_MICRO_USD
            || !Number.isFinite(admittedAt) || admittedAt >= a.submitBeforeMs) {
            return this.pause(tx, loaded, context, 'CAMPAIGN_ADMISSION_INVALID');
          }
          ceiling = a.maxReservationMicroUsd;
        }
        const inputTokenBound = Buffer.byteLength(body, 'utf8') + 4096;
        if (inputTokenBound > 272000) return this.pause(tx, loaded, context, 'LAB_BUDGET_INPUT_TOO_LARGE');
        const reservedMicroUsd = Math.ceil(inputTokenBound * 2.5 + 1200 * 15);
        if (ceiling !== undefined && reservedMicroUsd > ceiling) return this.pause(tx, loaded, context, 'CAMPAIGN_CEILING_EXCEEDED');
        if (!/^\d+$/.test(budget.total)) throw new Error('Invalid ledger');
        if (BigInt(budget.total) + BigInt(reservedMicroUsd) > BigInt(this.config.LAB_BUDGET_LIMIT_MICRO_USD!)) {
          return this.pause(tx, loaded, context, 'LAB_BUDGET_EXHAUSTED');
        }
        // One fused phase: do not label this as three separately measured legacy phases.
        // This interval ends BEFORE the context UPDATE, reservation INSERT and COMMIT.
        const duration = Math.round(this.clock() - started);
        if (!Number.isSafeInteger(duration) || duration < 0) throw new Error('Invalid monotonic clock');
        const backendTimings = { attempt: job.attempts, dispatchPreparationUntilContextWriteMs: duration };
        await tx.query('UPDATE sdr.jobs SET context=$4 WHERE tenant_id=$1 AND brand_id=$2 AND id=$3', [...s, job.id, JSON.stringify({ ...operationalContext, backendTimings })]);
        this.requireLive(job);
        const reserved = await tx.query(`INSERT INTO sdr.events(id,tenant_id,brand_id,conversation_id,type,detail)
          SELECT $3,$1,$2,$4,'lab_model_budget_reserved',$5 FROM sdr.jobs
          WHERE tenant_id=$1 AND brand_id=$2 AND id=$6 AND state='working' AND attempts=$7 AND deadline>clock_timestamp()
          RETURNING id`, [...s, reservationId, job.conversation_id,
          JSON.stringify({ gateId, jobId: job.id, attempt: job.attempts, inputTokenBound, reservedMicroUsd, costMicroUsd: reservedMicroUsd, settled: false }), job.id, job.attempts]);
        if (reserved.rows.length !== 1) throw new ExpiredPreparation();
        return { success: true, data: { kind: 'ready', body, jobId: job.id, attempt: job.attempts, contentHash: version.content_hash, reservationId, inputTokenBound, reservedMicroUsd } };
      });
    } catch (error) {
      if (error instanceof ExpiredPreparation) return { success: true, data: { kind: 'ignored', reason: 'STALE_JOB' } };
      return { success: false, error: { code: 'DISPATCH_PREPARATION_FAILED' } };
    }
  }

  private requireLive(job: Header['job']): void {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error('Invalid internal clock');
    if (job.deadline <= now) throw new ExpiredPreparation();
  }

  private async capability(tx: Queryable, job: Header['job'], reason: 'AUDIO_REQUIRES_TEXT' | 'UNSUPPORTED_MESSAGE'): Promise<LaboratoryDispatchResult> {
    this.requireLive(job);
    const text = reason === 'AUDIO_REQUIRES_TEXT' ? 'Nesta etapa do laboratório, envie sua mensagem por texto.'
      : 'Nesta etapa, consigo conversar por texto e receber áudio. Pode escrever a sua dúvida?';
    const result = { bubbles: [text], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'continue', handoffReason: null };
    const s = [this.channel.tenantId, this.channel.brandId];
    await tx.query("UPDATE sdr.jobs SET state='completed',result=$4,completed_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3", [...s, job.id, JSON.stringify(result)]);
    await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text',$6,now()) ON CONFLICT DO NOTHING",
      [...s, job.id + ':capability', job.conversation_id, job.candidate_id, text]);
    return { success: true, data: { kind: 'capability', reason } };
  }

  private async pause(tx: Queryable, loaded: Header, context: Record<string, unknown>, code: PauseCode): Promise<LaboratoryDispatchResult> {
    this.requireLive(loaded.job);
    const text = code === 'LAB_BUDGET_EXHAUSTED'
      ? 'A cota de testes desta etapa foi atingida. A equipe precisa liberar uma nova cota para continuar.'
      : code === 'CAMPAIGN_CEILING_EXCEEDED'
      ? 'O processamento deste teste está pausado porque a reserva necessária ultrapassa o limite deste turno. A equipe precisa revisar a admissão.'
      : code === 'CAMPAIGN_ADMISSION_INVALID'
      ? 'O processamento deste teste está pausado. A equipe precisa verificar a admissão deste turno.'
      : 'O processamento deste teste está pausado. A equipe precisa verificar a cota de testes para continuar.';
    const result = { bubbles: [text], proposals: [], relations: [], referral: null, sourceRefs: [], nextAction: 'handoff', handoffReason: text };
    const s = [this.channel.tenantId, this.channel.brandId], job = loaded.job;
    const marker = job.context && typeof job.context === 'object' && 'campaignAdmission' in job.context ? job.context.campaignAdmission : undefined;
    const operationalContext = { ...context, ...(marker !== undefined ? { campaignAdmission: marker } : {}) };
    await tx.query("UPDATE sdr.jobs SET state='handoff',error_code=$4,result=$5,context=$6,completed_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3",
      [...s, job.id, code, JSON.stringify(result), JSON.stringify(operationalContext)]);
    await tx.query("UPDATE sdr.conversations SET state='human',epoch=epoch+1,updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3", [...s, job.conversation_id]);
    await tx.query("UPDATE sdr.candidates SET lead_state=jsonb_set(lead_state,'{status}','\"handoff\"'),updated_at=now() WHERE tenant_id=$1 AND brand_id=$2 AND id=$3", [...s, job.candidate_id]);
    await tx.query("INSERT INTO sdr.messages(id,tenant_id,brand_id,conversation_id,candidate_id,actor,type,text,provider_timestamp) VALUES($3,$1,$2,$4,$5,'agent','text',$6,now()) ON CONFLICT DO NOTHING",
      [...s, job.id + ':budget', job.conversation_id, job.candidate_id, text]);
    return { success: true, data: { kind: 'paused', reason: code } };
  }
}
