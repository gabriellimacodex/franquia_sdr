import { z } from 'zod';
const count=z.number().int().nonnegative();
/** Provider usage only: strip unrecognized fields so message text cannot hide in metrics. */
export const UsageSchema=z.object({input_tokens:count.optional(),output_tokens:count.optional(),total_tokens:count.optional(),input_tokens_details:z.object({cached_tokens:count.optional()}).optional(),output_tokens_details:z.object({reasoning_tokens:count.optional()}).optional()});
export function estimateCost(usage:z.infer<typeof UsageSchema>,rates:{input:number,cachedInput:number,output:number}|null):number|null {
 if(!rates||usage.input_tokens===undefined||usage.output_tokens===undefined)return null;
 const cached=Math.min(usage.input_tokens,usage.input_tokens_details?.cached_tokens??0);
 return ((usage.input_tokens-cached)*rates.input+cached*rates.cachedInput+usage.output_tokens*rates.output)/1_000_000;
}
