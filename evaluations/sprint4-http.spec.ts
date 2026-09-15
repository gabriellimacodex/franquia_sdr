import { z } from 'zod';
import { CampaignPlanSchema, CampaignTargetSchema } from './sprint4-campaign.spec.js';
import { ControllerOutputSchema } from './sprint4-controller.spec.js';
import { ConversationReviewRecordSchema } from '../src/conversation-review.spec.js';

const Timestamp=z.string().datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)));
export const HttpInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('identity')}).strict(),
 z.object({action:z.literal('advance'),plan:CampaignPlanSchema,expectedTurnId:z.string().min(1).max(200).optional()}).strict(),
 z.object({action:z.literal('create-session'),mode:z.enum(['evaluation','published']),requestId:z.string().uuid(),label:z.string().trim().min(1).max(80),
  scenario:z.enum(['free','investment','correction','human']),target:CampaignTargetSchema}).strict(),
 z.object({action:z.literal('detail'),sessionId:z.string().uuid(),target:CampaignTargetSchema}).strict(),
 z.object({action:z.literal('review-history'),sessionId:z.string().uuid()}).strict(),
]);
export const HttpIdentitySchema=z.object({userId:z.string().min(1).max(200),tenantId:z.literal('cognita-homologacao'),brandId:z.literal('sapore'),role:z.literal('admin')}).strict();
export const HttpSessionSchema=z.object({id:z.string().uuid(),candidateId:z.string().uuid(),label:z.string().min(1).max(80),scenario:z.enum(['free','investment','correction','human']),versionId:z.string().min(1).max(200),state:z.string().min(1).max(40)}).strict();
export const HttpDetailSchema=z.object({session:HttpSessionSchema,
 messages:z.array(z.object({id:z.string().min(1).max(400),actor:z.string().min(1).max(40),text:z.string().max(4000),createdAt:Timestamp}).strict()),
 job:z.object({id:z.string().min(1).max(200),state:z.string().min(1).max(40),errorCode:z.string().max(200).nullable(),deadline:Timestamp}).strict().nullable(),
}).strict();
export const HttpSendResponseSchema=z.object({jobId:z.string().min(1).max(200).nullable(),detail:HttpDetailSchema}).strict();
const HttpReviewRecordSchema=ConversationReviewRecordSchema.refine(review=>[review.reviewedAt,...review.target.turns.map(turn=>turn.completedAt),...review.target.messages.map(message=>message.createdAt)]
 .every(value=>Timestamp.safeParse(value).success),'Invalid review timestamp');
export const HttpReviewHistorySchema=z.object({reviews:z.array(HttpReviewRecordSchema)}).strict();
export const HttpOutputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('identity'),identity:HttpIdentitySchema}).strict(),
 z.object({kind:z.literal('session-created'),session:HttpSessionSchema}).strict(),
 z.object({kind:z.literal('detail'),detail:HttpDetailSchema}).strict(),
 HttpReviewHistorySchema.extend({kind:z.literal('review-history'),sessionId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('controller'),state:ControllerOutputSchema}).strict(),
 z.object({kind:z.literal('submission-confirmed'),turnId:z.string(),requestId:z.string().uuid(),sessionId:z.string().uuid(),jobId:z.string(),detail:HttpDetailSchema,
  observedAtMs:z.number().int().nonnegative(),executionAudit:z.literal('pending')}).strict(),
]);
export const HttpErrorSchema=z.object({code:z.enum(['INVALID_INPUT','INVALID_CREDENTIAL','AUTH_FAILED','HTTP_FAILED','INVALID_RESPONSE','TRANSPORT_FAILED','CONTROLLER_FAILED','DISPATCH_INVALID']),requestAttempted:z.boolean(),requiresAudit:z.boolean()}).strict();
export const HttpResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:HttpOutputSchema}).strict(),
 z.object({success:z.literal(false),error:HttpErrorSchema}).strict(),
]);
export type HttpResult=z.infer<typeof HttpResultSchema>;
export interface Sprint4HttpSpec {execute(raw:unknown):Promise<HttpResult>}
