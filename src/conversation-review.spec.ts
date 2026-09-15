import { z } from 'zod';
import type { LabIdentity } from './lab.js';
import { LeadFactSchema, RelationProposalSchema } from './domain.js';

const Id=z.string().min(1).max(256),Hash=z.string().regex(/^[a-f0-9]{64}$/),DateText=z.string().datetime({offset:true});
export const ConversationReviewScoresSchema=z.object({intentContext:z.number().int().min(1).max(5),commercialFidelity:z.number().int().min(1).max(5),
 clarityNaturalness:z.number().int().min(1).max(5),nextStepUtility:z.number().int().min(1).max(5)}).strict();
export const ConversationReviewSubmissionSchema=z.object({jobId:Id,targetHash:Hash,idempotencyKey:z.string().uuid(),scores:ConversationReviewScoresSchema,notes:z.string().trim().min(1).max(4000)}).strict();
export const ConversationReviewTargetSchema=z.object({kind:z.literal('sprint4-conversation-target-v1'),tenantId:Id,brandId:Id,conversationId:Id,candidateId:Id,selectedJobId:Id,
 turns:z.array(z.object({jobId:Id,versionId:Id,contentHash:Hash,model:Id,status:Id,completedAt:DateText,triggerMessageId:Id,responseMessageIds:z.array(Id).min(1),
  sources:z.array(z.object({id:Id,title:z.string(),excerpt:z.string()}).strict()),excludedSources:z.array(z.object({id:Id,title:z.string(),reason:z.string()}).strict()),guardCodes:z.array(z.string()),
  memoryBefore:z.object({facts:z.array(LeadFactSchema),relations:z.array(RelationProposalSchema)}).strict().nullable(),
 }).strict()).min(1),
 messages:z.array(z.object({id:Id,actor:Id,type:Id,text:z.string(),createdAt:DateText,jobId:Id.nullable()}).strict()).min(1),limitations:z.array(z.string()).min(1),
}).strict();
export type ConversationReviewTarget=z.infer<typeof ConversationReviewTargetSchema>;
export const ConversationReviewRecordSchema=ConversationReviewSubmissionSchema.extend({id:Id,kind:z.literal('sprint4-human-review-v1'),rubric:z.literal('sprint4-conversation-v1'),
 actorUserId:Id,reviewedAt:DateText,target:ConversationReviewTargetSchema}).strict();
export type ConversationReviewRecord=z.infer<typeof ConversationReviewRecordSchema>;
export const ConversationReviewInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('target'),conversationId:Id,jobId:Id}).strict(),
 z.object({action:z.literal('history'),conversationId:Id}).strict(),
 z.object({action:z.literal('record'),conversationId:Id,submission:ConversationReviewSubmissionSchema}).strict(),
]);
export const ConversationReviewResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:z.union([
  z.object({targetHash:Hash,target:ConversationReviewTargetSchema}).strict(),
  z.object({reviews:z.array(ConversationReviewRecordSchema)}).strict(),
  z.object({review:ConversationReviewRecordSchema,duplicate:z.boolean()}).strict(),
 ])}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','FORBIDDEN','TARGET_NOT_FOUND','TARGET_NOT_REVIEWABLE','INCOMPLETE_TARGET','TARGET_CHANGED','REVIEW_CONFLICT','READ_FAILED'])}).strict()}).strict(),
]);
export type ConversationReviewResult=z.infer<typeof ConversationReviewResultSchema>;
export interface ConversationReviewSpec {execute(identity:LabIdentity,raw:unknown):Promise<ConversationReviewResult>}
