import { z } from 'zod';
import { CampaignPlanSchema } from './sprint4-campaign.spec.js';
import { ReceiptSchema } from './sprint4-controller.spec.js';
import { terminalEvidenceHash, type EvidenceStorageSpec } from './sprint4-evidence.spec.js';
import { ReviewPacketSchema } from './sprint4-review-packet.spec.js';
import { ConversationReviewRecordSchema } from '../src/conversation-review.spec.js';

const Id=z.string().min(1).max(200),Hash=z.string().regex(/^[a-f0-9]{64}$/);
const Criterion=z.enum(['O1','O2','O3','O4','O5','O6','O7','O8']);
const CriteriaRef=z.string().regex(/^criteria-sha256:[a-f0-9]{64}$/);
const TerminalRef=z.string().regex(/^terminal-sha256:[a-f0-9]{64}$/);
const ProofRef=z.string().regex(/^proof-sha256:[a-f0-9]{64}$/);
export const CriterionAssessorSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('human'),actorUserId:Id}).strict(),
 z.object({kind:z.literal('system'),systemId:Id}).strict(),
]);
export const CriterionEvidenceSchema=z.object({obligation:Id,ref:ProofRef,sha256:Hash}).strict()
 .refine(value=>value.ref==='proof-sha256:'+value.sha256,'Proof reference mismatch');
export const TurnCriteriaSchema=z.object({turnId:Id,artifactRef:TerminalRef,criteria:z.array(z.object({
 id:Criterion,status:z.enum(['passed','failed','pending']),assessor:CriterionAssessorSchema.nullable(),
 notes:z.string().trim().min(1).max(4000),evidence:z.array(CriterionEvidenceSchema),
 }).strict()).length(8)}).strict().refine(value=>new Set(value.criteria.map(c=>c.id)).size===8,'One judgment per criterion required');
export const CriteriaArtifactPayloadSchema=z.object({kind:z.literal('sprint4-criteria-v1'),planHash:Hash,executionId:Id,turnId:Id,
 reviewId:Id,reviewTargetHash:Hash,assessedAt:z.string().datetime({offset:true}),turns:z.array(TurnCriteriaSchema).min(1).max(2),
}).strict();
export const CriteriaArtifactSchema=z.object({ref:CriteriaRef,sha256:Hash,payload:CriteriaArtifactPayloadSchema}).strict()
 .refine(value=>value.sha256===terminalEvidenceHash(value.payload)&&value.ref==='criteria-sha256:'+value.sha256,'Criteria digest mismatch');
export type CriteriaArtifact=z.infer<typeof CriteriaArtifactSchema>;
export const CriterionEvidenceBindingSchema=z.object({planHash:Hash,executionId:Id,turnId:Id,artifactRef:TerminalRef,reviewId:Id,
 reviewTargetHash:Hash,criterion:Criterion,obligation:Id,assessor:CriterionAssessorSchema,
 judgment:z.object({status:z.enum(['passed','failed']),notes:z.string().trim().min(1).max(4000),assessedAt:z.string().datetime({offset:true})}).strict(),
}).strict();
export type CriterionEvidenceBinding=z.infer<typeof CriterionEvidenceBindingSchema>;
export interface ReviewedReceiptDependencies {
 storage:EvidenceStorageSpec;
 /** Authenticated, read-only source of the persisted review event, never a caller-supplied DTO. */
 reviews:{read(reviewId:string):Promise<unknown|null>};
 criteria:{
  /** Immutable content-addressed archive; must authenticate the recorded assessors. */
  read(ref:string):Promise<unknown|null>;
  /** Independently reread/hash the private proof and validate this exact binding and assessor.
   * True means a substantive obligation is fulfilled, not merely that its absence was attested.
   * Provider raw is retained when available, never reconstructed. When the terminal archive
   * declares it unavailable, that explicit gap needs no retroactive existence proof. Legacy
   * references for the raw gap remain unverified metadata, never raw or human O8 evidence.
   * A reference or a claimed verdict alone is not proof. No remote adapter is installed here. */
  verifyEvidence(request:{ref:string;sha256:string;binding:CriterionEvidenceBinding}):Promise<boolean>;
 };
}
export const ReviewedReceiptInputSchema=z.union([
 z.object({plan:CampaignPlanSchema,turnId:Id,reviewId:Id,criteriaArtifactRef:CriteriaRef}).strict(),
 /** Receipt is only a lookup key and an equality claim; never trusted as an audit decision. */
 z.object({plan:CampaignPlanSchema,turnId:Id,receipt:ReceiptSchema}).strict(),
]);
export const ReviewedReceiptPackagePayloadSchema=z.object({kind:z.literal('sprint4-reviewed-receipt-package-v1'),
 packet:ReviewPacketSchema,review:ConversationReviewRecordSchema,criteria:CriteriaArtifactSchema,
 humanSample:z.enum(['partial-execution','complete-execution']),acceptance:z.literal('pending'),
 limitations:z.array(z.string()).min(1),
}).strict();
export const ReviewedReceiptPackageSchema=z.object({ref:z.string().regex(/^reviewed-receipt-sha256:[a-f0-9]{64}$/),sha256:Hash,
 payload:ReviewedReceiptPackagePayloadSchema}).strict().refine(value=>value.sha256===terminalEvidenceHash(value.payload)&&
 value.ref==='reviewed-receipt-sha256:'+value.sha256,'Package digest mismatch');
export type ReviewedReceiptPackage=z.infer<typeof ReviewedReceiptPackageSchema>;
export const ReviewedReceiptResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('awaiting-review'),turnId:Id,gaps:z.array(z.string()).min(1)}).strict(),
  z.object({kind:z.literal('halted'),turnId:Id,findings:z.array(z.string()).min(1),receipt:ReceiptSchema}).strict(),
  z.object({kind:z.literal('receipt'),receipt:ReceiptSchema,package:ReviewedReceiptPackageSchema}).strict(),
 ])}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','INVALID_PLAN','EVIDENCE_MISMATCH','DEPENDENCY_FAILED'])}).strict()}).strict(),
]);
export type ReviewedReceiptResult=z.infer<typeof ReviewedReceiptResultSchema>;
export interface Sprint4ReviewedReceiptSpec {execute(raw:unknown):Promise<ReviewedReceiptResult>}
