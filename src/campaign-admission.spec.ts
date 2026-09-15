import { z } from 'zod';

const Id=z.string().min(1).max(200),Hash=z.string().regex(/^[a-f0-9]{64}$/);
/** A caller-requested restriction, never proof of identity or permission to pay.
 * submitBeforeMs expires submission, not the independently created job deadline. */
export const CampaignAdmissionRequestSchema=z.object({
 runId:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),turnId:Id,
 target:z.object({versionId:Id,contentHash:Hash,model:z.literal('gpt-5.4-2026-03-05')}).strict(),
 maxReservationMicroUsd:z.number().int().positive().max(1_000_000),
 submitBeforeMs:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
/** Stored by the backend; all identity/job fields come from authenticated scoped rows. */
export const CampaignAdmissionSchema=CampaignAdmissionRequestSchema.extend({
 kind:z.literal('campaign-admission-v1'),tenantId:z.literal('cognita-homologacao'),brandId:z.literal('sapore'),
 actorUserId:Id,sessionId:Id,requestId:z.string().uuid(),jobId:Id,candidateId:Id,
 contextVersion:z.number().int().nonnegative(),epoch:z.number().int().nonnegative(),
 gateId:z.literal('sprint3-continuous-20260910'),limitMicroUsd:z.literal(1_000_000),
}).strict();
export const CampaignAdmissionMarkerSchema=z.object({id:Id,contentHash:Hash}).strict();
