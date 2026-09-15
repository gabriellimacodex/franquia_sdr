import { scoped, type Database } from './database.js';
import type { Channel } from './store.js';
import { DispatchFailureInputSchema, type DispatchFailureSpec, type DispatchFailureResult } from './dispatch-failure.spec.js';

/** A failed ACK cannot prove a paid request failed. Read the durable reservation
 * under the same lock as claim/preparation; never reopen a newer or terminal job. */
export class DispatchFailure implements DispatchFailureSpec {
 constructor(private readonly db:Database,private readonly channel:Channel) {}
 async execute(raw:unknown):Promise<DispatchFailureResult> {
  const parsed=DispatchFailureInputSchema.safeParse(raw);
  if(!parsed.success)return {success:false,error:{code:'INVALID_INPUT'}};
  try {
   return await scoped(this.db,this.channel,async tx=>{
    const {jobId,attempt}=parsed.data;
    const row=(await tx.query<{state:string}>(`WITH reservation AS (
     SELECT $6::boolean AND EXISTS(SELECT 1 FROM sdr.events WHERE tenant_id=$1 AND brand_id=$2
      AND type='lab_model_budget_reserved' AND detail->>'jobId'=$3) AS ambiguous
    ) UPDATE sdr.jobs SET
     state=CASE WHEN reservation.ambiguous THEN state ELSE 'pending' END,
     available_at=CASE WHEN reservation.ambiguous THEN available_at ELSE now()+interval '5 seconds' END,
     error_code=CASE WHEN reservation.ambiguous THEN 'ORCHESTRATOR_ACK_UNKNOWN' ELSE 'ORCHESTRATOR_UNAVAILABLE' END
    FROM reservation WHERE tenant_id=$1 AND brand_id=$2 AND id=$3 AND attempts=$4
     AND split_part(id,':',1)=$5 AND state='working' RETURNING state`,[
      this.channel.tenantId,this.channel.brandId,jobId,attempt,this.channel.phoneNumberId,this.channel.kind==='laboratory',
     ])).rows[0];
    return {success:true,data:{kind:!row?'ignored':row.state==='working'?'awaiting_callback':'requeued'}};
   });
  } catch {return {success:false,error:{code:'FAILURE_RECORDING_FAILED'}};}
 }
}
