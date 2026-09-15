import type { Queryable, Scope } from './database.js';
import type { LeadState } from './domain.js';

/** Persist projections within the caller's existing scoped transaction. */
export async function persistLeadMemory(tx:Queryable,scope:Scope,candidateId:string,memory:Pick<LeadState,'facts'|'relations'>):Promise<void> {
 // A batch cannot update the same conflict key twice; preserve the former loop's last value.
 const facts=[...new Map(memory.facts.map(data=>[data.id,data])).values()];
 if(memory.facts.length)await tx.query(`INSERT INTO sdr.facts(id,tenant_id,brand_id,candidate_id,data)
  SELECT item.id,$1,$2,$3,item.data FROM jsonb_to_recordset($4::jsonb) AS item(id text,data jsonb)
  ON CONFLICT(tenant_id,brand_id,id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()
  WHERE sdr.facts.data IS DISTINCT FROM EXCLUDED.data`,
  [scope.tenantId,scope.brandId,candidateId,JSON.stringify(facts.map(data=>({id:data.id,data})))]);
 if(memory.relations.length)await tx.query(`INSERT INTO sdr.relations(id,tenant_id,brand_id,candidate_id,data)
  SELECT item.id,$1,$2,$3,item.data FROM jsonb_to_recordset($4::jsonb) AS item(id text,data jsonb)
  ON CONFLICT DO NOTHING`,
  [scope.tenantId,scope.brandId,candidateId,JSON.stringify(memory.relations.map(data=>({id:candidateId+':'+data.id,data})))]);
}
