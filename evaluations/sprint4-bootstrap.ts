import { createHash, randomUUID } from 'node:crypto';
import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { HttpResultSchema } from './sprint4-http.spec.js';
import { BootstrapInputSchema, BootstrapIntentSchema, BootstrapObservationSchema, BootstrapReconciliationResultSchema, BootstrapStorageResultSchema,
 type BootstrapDependencies, type BootstrapIntent, type BootstrapObservation, type BootstrapRecord, type BootstrapResult, type Sprint4BootstrapSpec } from './sprint4-bootstrap.spec.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=(code:Extract<BootstrapResult,{success:false}>['error']['code'],requiresReconciliation=false):BootstrapResult=>({success:false,error:{code,requiresReconciliation}});
const matchesObservation=(intent:BootstrapIntent,observation:BootstrapObservation)=>observation.intentHash===hash(intent)&&observation.observedAtMs>=intent.createdAtMs&&
 observation.session.versionId===intent.target.versionId&&observation.session.label===intent.label&&observation.session.scenario===intent.scenario;

/** Session creation only. A recorded session is historical evidence, never permission to dispatch. */
export class Sprint4Bootstrap implements Sprint4BootstrapSpec {
 constructor(private readonly dependencies:BootstrapDependencies){}
 async execute(raw:unknown):Promise<BootstrapResult>{
  let requiresReconciliation=false;
  try{
   const parsed=BootstrapInputSchema.safeParse(raw);if(!parsed.success)return failure('INVALID_INPUT');
   const validated=new Sprint4CampaignPlanner().validate(parsed.data.plan);if(!validated.success)return failure('INVALID_PLAN');
   const plan=validated.data,execution=plan.phases.flatMap(phase=>phase.executions).find(item=>item.id===parsed.data.executionId);
   if(!execution)return failure('INVALID_PLAN');
   const key={runId:plan.request.runId,executionId:execution.id};
   const base={kind:'sprint4-session-intent-v1',...key,planHash:hash(plan),actorUserId:plan.request.actorUserId,target:plan.request.target,
    mode:execution.phase==='m6-published'?'published':'evaluation',label:`S4 ${execution.repetition} ${execution.caseId} ${hash(execution.id).slice(0,16)}`,
    scenario:execution.caseId==='C02'?'correction':execution.caseId==='C03'?'investment':'free'};
   const fromStored=(previous:BootstrapRecord):BootstrapResult=>{
    const expected=BootstrapIntentSchema.parse({...base,requestId:previous.intent.requestId,createdAtMs:previous.intent.createdAtMs});
    if(hash(previous.intent)!==hash(expected)||previous.observation&&!matchesObservation(previous.intent,previous.observation))return failure('STATE_MISMATCH',true);
    if(previous.observation)return {success:true,data:{kind:'session-recorded',executionId:execution.id,record:{intent:previous.intent,observation:previous.observation}}};
    return {success:true,data:{kind:'awaiting-reconciliation',executionId:execution.id,requestId:previous.intent.requestId}};
   };
   requiresReconciliation=true;
   const read=BootstrapStorageResultSchema.safeParse(await this.dependencies.storage.execute({action:'read',...key}));
   if(!read.success||!read.data.success||read.data.data.kind!=='read')return failure('STORAGE_FAILED',true);
   const previous=read.data.data.record;
   requiresReconciliation=previous!==null;
   if(previous){
    const cached=fromStored(previous);
    if(!cached.success||cached.data.kind==='session-recorded'||parsed.data.action!=='reconcile')return cached;
    requiresReconciliation=true;
    if(!this.dependencies.reconciler)return failure('RECONCILIATION_UNCONFIRMED',true);
    const found=BootstrapReconciliationResultSchema.safeParse(await this.dependencies.reconciler.inspect(structuredClone(previous.intent)));
    if(!found.success||!found.data.success)return failure('RECONCILIATION_UNCONFIRMED',true);
    if(found.data.data.kind==='not-found')return found.data.data.intentHash===hash(previous.intent)&&found.data.data.observedAtMs>=previous.intent.createdAtMs?cached:failure('STATE_MISMATCH',true);
    const observation=found.data.data.observation;
    if(observation.source!=='database-readonly'||!matchesObservation(previous.intent,observation))return failure('STATE_MISMATCH',true);
    const saved=BootstrapStorageResultSchema.safeParse(await this.dependencies.storage.execute({action:'record-session-once',...key,observation}));
    if(!saved.success||!saved.data.success||saved.data.data.kind!=='recorded')return failure('STORAGE_FAILED',true);
    return {success:true,data:{kind:'session-recorded',executionId:execution.id,record:{intent:previous.intent,observation}}};
   }
   if(parsed.data.action==='reconcile')return failure('STATE_MISMATCH');
   const identity=HttpResultSchema.safeParse(await this.dependencies.http.execute({action:'identity'}));
   if(!identity.success||!identity.data.success||identity.data.data.kind!=='identity'||identity.data.data.identity.userId!==plan.request.actorUserId)return failure('AUTH_FAILED');
   const intent=BootstrapIntentSchema.parse({...base,requestId:(this.dependencies.requestId??randomUUID)(),createdAtMs:(this.dependencies.nowMs??Date.now)()});
   requiresReconciliation=true;
   const claim=BootstrapStorageResultSchema.safeParse(await this.dependencies.storage.execute({action:'claim-once',intent}));
   if(!claim.success||!claim.data.success&&claim.data.error.code!=='STATE_CONFLICT'||claim.data.success&&claim.data.data.kind!=='claimed')return failure('STORAGE_FAILED',true);
   if(!claim.data.success||claim.data.data.kind==='claimed'&&!claim.data.data.claimed){
    const winner=BootstrapStorageResultSchema.safeParse(await this.dependencies.storage.execute({action:'read',...key}));
    return winner.success&&winner.data.success&&winner.data.data.kind==='read'&&winner.data.data.record?fromStored(winner.data.data.record):failure('STORAGE_FAILED',true);
   }
   const response=HttpResultSchema.safeParse(await this.dependencies.http.execute({action:'create-session',mode:intent.mode,requestId:intent.requestId,label:intent.label,scenario:intent.scenario,target:intent.target}));
   if(!response.success||!response.data.success||response.data.data.kind!=='session-created')return failure('CREATION_UNCONFIRMED',true);
   const observation=BootstrapObservationSchema.parse({kind:'sprint4-session-observation-v1',intentHash:hash(intent),source:'http',evidenceRef:`http-session:${intent.requestId}`,
    observedAtMs:(this.dependencies.nowMs??Date.now)(),session:response.data.data.session});
   if(!matchesObservation(intent,observation))return failure('CREATION_UNCONFIRMED',true);
   const recorded=BootstrapStorageResultSchema.safeParse(await this.dependencies.storage.execute({action:'record-session-once',...key,observation}));
   if(!recorded.success||!recorded.data.success||recorded.data.data.kind!=='recorded')return failure('STORAGE_FAILED',true);
   return {success:true,data:{kind:'session-recorded',executionId:execution.id,record:{intent,observation}}};
  }catch{return failure('DEPENDENCY_FAILED',requiresReconciliation);}
 }
}
