import { z } from 'zod';
import { CampaignPlanSchema, CampaignTargetSchema } from './sprint4-campaign.spec.js';
import { HttpSessionSchema, type Sprint4HttpSpec } from './sprint4-http.spec.js';

const Id=z.string().min(1).max(200),Hash=z.string().regex(/^[a-f0-9]{64}$/),Millis=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const RunId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const BootstrapIntentSchema=z.object({
 kind:z.literal('sprint4-session-intent-v1'),runId:RunId,executionId:Id,planHash:Hash,actorUserId:Id,target:CampaignTargetSchema,
 requestId:z.string().uuid(),mode:z.enum(['evaluation','published']),label:z.string().min(1).max(80),scenario:z.enum(['free','investment','correction','human']),createdAtMs:Millis,
}).strict();
export type BootstrapIntent=z.infer<typeof BootstrapIntentSchema>;
export const BootstrapObservationSchema=z.object({
 kind:z.literal('sprint4-session-observation-v1'),intentHash:Hash,source:z.enum(['http','database-readonly']),evidenceRef:Id,
 observedAtMs:Millis,session:HttpSessionSchema,
}).strict();
export type BootstrapObservation=z.infer<typeof BootstrapObservationSchema>;
export const BootstrapRecordSchema=z.object({intent:BootstrapIntentSchema,observation:BootstrapObservationSchema.nullable()}).strict();
export type BootstrapRecord=z.infer<typeof BootstrapRecordSchema>;
export const BootstrapStorageInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('read'),runId:RunId,executionId:Id}).strict(),
 z.object({action:z.literal('claim-once'),intent:BootstrapIntentSchema}).strict(),
 z.object({action:z.literal('record-session-once'),runId:RunId,executionId:Id,observation:BootstrapObservationSchema}).strict(),
 z.object({action:z.literal('close')}).strict(),
]);
export const BootstrapStorageOutputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('read'),record:BootstrapRecordSchema.nullable()}).strict(),
 z.object({kind:z.literal('claimed'),claimed:z.boolean()}).strict(),
 z.object({kind:z.literal('recorded'),duplicate:z.boolean()}).strict(),
 z.object({kind:z.literal('closed')}).strict(),
]);
export const BootstrapStorageResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:BootstrapStorageOutputSchema}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','UNSAFE_STORAGE','CORRUPT_STATE','STATE_CONFLICT','STORAGE_FAILURE','CLOSED'])}).strict()}).strict(),
]);
export type BootstrapStorageResult=z.infer<typeof BootstrapStorageResultSchema>;
export interface BootstrapStorageSpec {execute(raw:unknown):Promise<BootstrapStorageResult>}

export const BootstrapInputSchema=z.object({action:z.enum(['ensure-session','reconcile']),plan:CampaignPlanSchema,executionId:Id}).strict();
export const BootstrapOutputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('session-recorded'),executionId:Id,record:BootstrapRecordSchema.extend({observation:BootstrapObservationSchema})}).strict(),
 z.object({kind:z.literal('awaiting-reconciliation'),executionId:Id,requestId:z.string().uuid()}).strict(),
]);
export const BootstrapResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:BootstrapOutputSchema}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','INVALID_PLAN','STATE_MISMATCH','AUTH_FAILED','STORAGE_FAILED','CREATION_UNCONFIRMED','RECONCILIATION_UNCONFIRMED','DEPENDENCY_FAILED']),requiresReconciliation:z.boolean()}).strict()}).strict(),
]);
export type BootstrapResult=z.infer<typeof BootstrapResultSchema>;
export const BootstrapReconciliationResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('session-observed'),observation:BootstrapObservationSchema}).strict(),
  z.object({kind:z.literal('not-found'),intentHash:Hash,observedAtMs:Millis}).strict(),
 ])}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','READ_FAILED','EVIDENCE_MISMATCH'])}).strict()}).strict(),
]);
export type BootstrapReconciliationResult=z.infer<typeof BootstrapReconciliationResultSchema>;
/** Trusted read-only lookup by exact actor/request/scope/pins. Absence never authorizes another POST. */
export interface BootstrapReconciler {inspect(intent:BootstrapIntent):Promise<BootstrapReconciliationResult>}
export interface Sprint4BootstrapSpec {execute(raw:unknown):Promise<BootstrapResult>}
export interface BootstrapDependencies {storage:BootstrapStorageSpec;http:Sprint4HttpSpec;reconciler?:BootstrapReconciler;nowMs?:()=>number;requestId?:()=>string}
