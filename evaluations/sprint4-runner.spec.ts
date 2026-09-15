import { z } from 'zod';
import { CampaignPlanSchema } from './sprint4-campaign.spec.js';
import type { CampaignJournal, Sprint4ControllerSpec } from './sprint4-controller.spec.js';
import { BootstrapResultSchema, type Sprint4BootstrapSpec } from './sprint4-bootstrap.spec.js';
import { HttpResultSchema, type Sprint4HttpSpec } from './sprint4-http.spec.js';
import type { EvidenceCaptureSpec } from './sprint4-evidence.spec.js';
import type { Sprint4ReviewedReceiptSpec } from './sprint4-reviewed-receipt.spec.js';

const Id=z.string().min(1).max(200);
export const RunnerInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('advance'),plan:CampaignPlanSchema}).strict(),
 z.object({action:z.literal('observe'),plan:CampaignPlanSchema,review:z.object({reviewId:Id,criteriaArtifactRef:Id}).strict().optional()}).strict(),
]);
export const RunnerResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('idle')}).strict(),
  z.object({kind:z.literal('halted'),turnId:Id,reason:z.enum(['critical','ambiguous','failed'])}).strict(),
  z.object({kind:z.literal('recorded'),turnId:Id,duplicate:z.boolean()}).strict(),
  z.object({kind:z.literal('awaiting-receipt'),turnId:Id}).strict(),
  z.object({kind:z.literal('awaiting-job'),turnId:Id}).strict(),
  z.object({kind:z.literal('awaiting-review'),turnId:Id,artifactRef:Id,gaps:z.array(z.string())}).strict(),
  z.object({kind:z.literal('advance-observed'),outcome:HttpResultSchema}).strict(),
  z.object({kind:z.literal('bootstrap-observed'),outcome:BootstrapResultSchema}).strict(),
 ])}).strict(),
 z.object({success:z.literal(false),error:z.object({code:z.enum(['INVALID_INPUT','INVALID_PLAN','STATE_MISMATCH','DEPENDENCY_FAILED'])}).strict()}).strict(),
]);
export type RunnerResult=z.infer<typeof RunnerResultSchema>;
export interface Sprint4RunnerSpec {execute(raw:unknown):Promise<RunnerResult>}
/** All adapters share the same immutable plan, journal and scope. No implicit credentials or sends. */
export interface RunnerDependencies {
 journal:CampaignJournal;bootstrap:Sprint4BootstrapSpec;http:Sprint4HttpSpec;controller:Sprint4ControllerSpec;capture:EvidenceCaptureSpec;
 review:Sprint4ReviewedReceiptSpec;
}
