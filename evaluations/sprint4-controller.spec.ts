import { z } from 'zod';
import { CampaignPlanSchema, CampaignTargetSchema, type CampaignPlan } from './sprint4-campaign.spec.js';
import { CampaignAdmissionRequestSchema } from '../src/campaign-admission.spec.js';

const Id=z.string().min(1).max(200),Millis=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PreflightSchema=z.object({
 turnId:Id,actorUserId:Id,target:CampaignTargetSchema,evidenceRef:Id,
 observedAtMs:Millis,validUntilMs:Millis,deadlineAtMs:Millis,
 adminActive:z.boolean(),routeValidated:z.boolean(),published:z.boolean(),healthy:z.boolean(),noUnexpectedJobs:z.boolean(),
 tenantId:z.literal('cognita-homologacao'),brandId:z.literal('sapore'),
 executionMode:z.literal('laboratory'),channelEnabled:z.literal(false),nativeControlVerified:z.literal(false),retentionEnabled:z.literal(false),
 sessionId:Id,sessionOwned:z.boolean(),sessionReady:z.boolean(),sessionFresh:z.boolean(),requestId:z.string().uuid(),
 budget:z.object({gateId:z.literal('sprint3-continuous-20260910'),limitMicroUsd:z.literal(1_000_000),accountedMicroUsd:Millis,
  exactPayloadBound:z.number().int().min(4096).max(272000),reservationMicroUsd:Millis,remainingCampaignReviewed:z.boolean()}).strict(),
 daily:z.object({actorUserId:Id,limitMessages:z.literal(100),rollingWindowHours:z.literal(24),usedMessages:z.number().int().min(0).max(100),stageAndControlsReviewed:z.boolean()}).strict(),
}).strict();
export type Preflight=z.infer<typeof PreflightSchema>;
/** Admission is a ceiling and readiness observation, not a measurement of a future job. */
export const AdmissionEvidenceSchema=PreflightSchema.omit({deadlineAtMs:true,budget:true}).extend({
 budget:z.object({gateId:z.literal('sprint3-continuous-20260910'),limitMicroUsd:z.literal(1_000_000),accountedMicroUsd:Millis,
  maxReservationMicroUsd:z.number().int().positive().max(1_000_000),remainingCampaignReviewed:z.boolean()}).strict(),
}).strict();
export type AdmissionEvidence=z.infer<typeof AdmissionEvidenceSchema>;
export const LegacyReceiptSchema=z.object({
 receiptId:Id,turnId:Id,requestId:z.string().uuid(),sessionId:Id,target:CampaignTargetSchema,observedAtMs:Millis,
 kind:z.enum(['accepted','terminal','ambiguous']),jobId:Id.nullable(),evidenceRef:Id,
 jobState:z.enum(['working','completed','failed','stale','cancelled','unknown']),
 guardCodes:z.array(Id),criticalCodes:z.array(Id),objectiveAudit:z.enum(['pending','passed','failed','unknown']),
 ledger:z.object({reservationId:Id.nullable(),state:z.enum(['settled','reserved','unknown']),costMicroUsd:Millis.nullable()}).strict(),
 responseArtifactRef:Id.nullable(),rawArtifactRef:Id.nullable(),
}).strict();
export type LegacyReceipt=z.infer<typeof LegacyReceiptSchema>;
export const PreparationMeasurementSchema=z.object({
 attempt:z.number().int().positive(),inputTokenBound:z.number().int().min(4096).max(272000),reservedMicroUsd:Millis,reservationId:Id,
}).strict();
export const ReceiptSchema=LegacyReceiptSchema.extend({
 kind:z.enum(['accepted','prepared','terminal','ambiguous']),jobDeadlineAtMs:Millis.nullable(),preparation:PreparationMeasurementSchema.nullable(),
 jobState:z.enum(['pending','running','working','ready','dispatched','completed','handoff','failed','stale','cancelled','unknown']),
 ledger:z.object({reservationId:Id.nullable(),state:z.enum(['not-reserved','settled','reserved','unknown']),costMicroUsd:Millis.nullable()}).strict(),
}).strict();
export type Receipt=z.infer<typeof ReceiptSchema>;
export const LegacyPreflightSchema=PreflightSchema;
const LegacyEntrySchema=z.object({turnId:Id,preflight:LegacyPreflightSchema,receipts:z.array(LegacyReceiptSchema)}).strict();
export const LegacyControllerStateSchema=z.object({revision:z.number().int().min(1),plan:CampaignPlanSchema,entries:z.array(LegacyEntrySchema)}).strict();
export type LegacyControllerState=z.infer<typeof LegacyControllerStateSchema>;
const EntrySchema=z.object({turnId:Id,admission:AdmissionEvidenceSchema,receipts:z.array(ReceiptSchema)}).strict();
export const ControllerStateSchema=z.object({protocol:z.literal('sprint4-admission-v2'),revision:z.number().int().min(1),plan:CampaignPlanSchema,entries:z.array(EntrySchema)}).strict();
export type ControllerState=z.infer<typeof ControllerStateSchema>;
export const StoredControllerStateSchema=z.union([ControllerStateSchema,LegacyControllerStateSchema]);
export type StoredControllerState=z.infer<typeof StoredControllerStateSchema>;
export const ControllerInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('next'),plan:CampaignPlanSchema,expectedTurnId:Id.optional()}).strict(),
 z.object({action:z.literal('record'),plan:CampaignPlanSchema,receipt:ReceiptSchema}).strict(),
]);
export const ControllerOutputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('dispatch-once'),turnId:Id,input:z.string(),sessionId:Id,requestId:z.string().uuid(),target:CampaignTargetSchema,validUntilMs:Millis,campaignAdmission:CampaignAdmissionRequestSchema}).strict(),
 z.object({kind:z.literal('awaiting-receipt'),turnId:Id}).strict(),
 z.object({kind:z.literal('halted'),turnId:Id,reason:z.enum(['critical','ambiguous','failed'])}).strict(),
 z.object({kind:z.literal('recorded'),turnId:Id,duplicate:z.boolean()}).strict(),
 z.object({kind:z.literal('sequence-recorded'),turnsRecorded:z.number().int(),acceptance:z.literal('pending')}).strict(),
]);
export const ControllerErrorSchema=z.object({code:z.enum(['INVALID_INPUT','INVALID_PLAN','STATE_MISMATCH','LEGACY_READ_ONLY','GATE_BLOCKED','CONCURRENT_CHANGE','RECEIPT_MISMATCH','RECEIPT_CONFLICT','DEPENDENCY_FAILED']),message:z.string()}).strict();
export const ControllerResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:ControllerOutputSchema}).strict(),
 z.object({success:z.literal(false),error:ControllerErrorSchema}).strict(),
]);
export type ControllerResult=z.infer<typeof ControllerResultSchema>;
export interface CampaignJournal {
 read(runId:string):Promise<unknown|null>;
 /** Atomic durable CAS shared by all processes; acknowledge only after commit. Never reset a run or erase receipts. */
 compareAndSwap(runId:string,expectedRevision:number|null,next:ControllerState):Promise<boolean>;
}
export interface CampaignEvidence {
 nowMs():number;
 /** Trusted read-only verification, not planner projections. It must not send or reserve funds.
  * Verify the real admin, immutable target, session, publication gates and current capacity.
  * Runtime atomic budget/deadline/ownership checks remain authoritative at actual dispatch. */
 inspect(request:{plan:CampaignPlan;turnId:string;expectedSessionId:string|null}):Promise<unknown>;
}
export interface Sprint4ControllerSpec {execute(raw:unknown):Promise<ControllerResult>}
