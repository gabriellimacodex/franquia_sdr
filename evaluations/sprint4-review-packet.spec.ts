import { z } from 'zod';
import { CampaignPlanSchema } from './sprint4-campaign.spec.js';
import { TerminalArtifactSchema } from './sprint4-evidence.spec.js';

const Id=z.string().min(1).max(200);
export const ReviewPacketInputSchema=z.object({plan:CampaignPlanSchema,turnId:Id}).strict();
export const ReviewCheckSchema=z.object({id:z.enum(['O1','O2','O3','O4','O5','O6','O7','O8']),
 status:z.enum(['partial','pending-human','findings']),verified:z.array(Id),findings:z.array(Id),pending:z.array(Id).min(1)}).strict();
export const ReviewPacketSchema=z.object({kind:z.literal('sprint4-review-packet-v1'),planHash:z.string().regex(/^[a-f0-9]{64}$/),
 executionId:Id,caseId:z.string().regex(/^C(?:0[1-9]|[12][0-9]|30)$/),throughTurn:z.union([z.literal(1),z.literal(2)]),allTurnsArchived:z.boolean(),
 objectiveAudit:z.literal('pending'),readyForReceipt:z.literal(false),
 humanReview:z.object({status:z.literal('pending'),evaluatorId:z.null(),scores:z.null(),reviewedAt:z.null()}).strict(),
 artifacts:z.array(TerminalArtifactSchema).min(1).max(2),checks:z.array(ReviewCheckSchema).length(8),
 findingsByTurn:z.array(z.object({criterion:ReviewCheckSchema.shape.id,code:Id,turnId:Id,artifactRef:z.string().regex(/^terminal-sha256:[a-f0-9]{64}$/)}).strict()),
}).strict();
export const ReviewPacketResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:ReviewPacketSchema}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','INVALID_PLAN','MISSING_ARTIFACT','EVIDENCE_MISMATCH','DEPENDENCY_FAILED'])}).strict()}).strict(),
]);
export type ReviewPacketResult=z.infer<typeof ReviewPacketResultSchema>;
export type ReviewCheck=z.infer<typeof ReviewCheckSchema>;
export interface ReviewPacketSpec {execute(raw:unknown):Promise<ReviewPacketResult>}
