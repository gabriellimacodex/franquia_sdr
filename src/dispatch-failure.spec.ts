import { z } from 'zod';

export const DispatchFailureInputSchema=z.object({jobId:z.string().min(1),attempt:z.number().int().positive()}).strict();
export const DispatchFailureDataSchema=z.object({kind:z.enum(['awaiting_callback','requeued','ignored'])}).strict();
export const DispatchFailureErrorSchema=z.object({code:z.enum(['INVALID_INPUT','FAILURE_RECORDING_FAILED'])}).strict();
export const DispatchFailureResultSchema=z.discriminatedUnion('success',[
 z.object({success:z.literal(true),data:DispatchFailureDataSchema}).strict(),
 z.object({success:z.literal(false),error:DispatchFailureErrorSchema}).strict(),
]);
export type DispatchFailureResult=z.infer<typeof DispatchFailureResultSchema>;
export interface DispatchFailureSpec {execute(raw:unknown):Promise<DispatchFailureResult>}
