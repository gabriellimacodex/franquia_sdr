import { z } from 'zod';
import { StoredControllerStateSchema } from './sprint4-controller.spec.js';

const RunId=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
export const JournalOptionsSchema=z.object({directory:z.string().min(1),initializeNew:z.boolean().default(false)}).strict();
export const JournalInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('read'),runId:RunId}).strict(),
 z.object({action:z.literal('compare-and-swap'),runId:RunId,expectedRevision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),next:StoredControllerStateSchema}).strict(),
 z.object({action:z.literal('close')}).strict(),
]);
export const JournalOutputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('read'),state:StoredControllerStateSchema.nullable()}).strict(),
 z.object({kind:z.literal('compared'),swapped:z.boolean()}).strict(),
 z.object({kind:z.literal('closed')}).strict(),
]);
export const JournalErrorSchema=z.object({code:z.enum(['INVALID_INPUT','UNSAFE_STORAGE','CORRUPT_STATE','INVALID_TRANSITION','STORAGE_FAILURE','CLOSED'])}).strict();
export const JournalResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:JournalOutputSchema}).strict(),
 z.object({success:z.literal(false),error:JournalErrorSchema}).strict(),
]);
export type JournalResult=z.infer<typeof JournalResultSchema>;
export type JournalErrorCode=z.infer<typeof JournalErrorSchema>['code'];
export interface Sprint4JournalSpec {execute(raw:unknown):Promise<JournalResult>}
