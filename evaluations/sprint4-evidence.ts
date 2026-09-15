import { ControllerStateSchema } from './sprint4-controller.spec.js';
import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { TerminalAuditResultSchema } from './sprint4-terminal-audit.spec.js';
import { EvidenceCaptureInputSchema, EvidenceStorageResultSchema, TerminalArtifactPayloadSchema, TerminalArtifactSchema, terminalEvidenceHash,
 type EvidenceCaptureDependencies, type EvidenceCaptureResult, type EvidenceCaptureSpec } from './sprint4-evidence.spec.js';

type Code=Extract<EvidenceCaptureResult,{success:false}>['error']['code'];
const fail=(code:Code):EvidenceCaptureResult=>({success:false,error:{code}});
/** Private capture only. No send, receipt, rating, credential lookup or live-read fallback over an existing artifact. */
export class Sprint4EvidenceCapture implements EvidenceCaptureSpec {
 constructor(private readonly dependencies:EvidenceCaptureDependencies){}
 async execute(raw:unknown):Promise<EvidenceCaptureResult>{
  try{
   const parsed=EvidenceCaptureInputSchema.safeParse(raw);if(!parsed.success)return fail('INVALID_INPUT');
   const validated=new Sprint4CampaignPlanner().validate(parsed.data.plan);if(!validated.success)return fail('INVALID_PLAN');
   const plan=validated.data,{turnId}=parsed.data,runId=plan.request.runId;
   const state=ControllerStateSchema.safeParse(await this.dependencies.journal.read(runId));
   if(!state.success)return fail('INTENT_NOT_FOUND');
   if(JSON.stringify(state.data.plan)!==JSON.stringify(plan))return fail('EVIDENCE_MISMATCH');
   const turns=plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns));
   if(state.data.entries.some((entry,index)=>entry.turnId!==turns[index]?.id||entry.admission.turnId!==entry.turnId||
    entry.admission.actorUserId!==plan.request.actorUserId||JSON.stringify(entry.admission.target)!==JSON.stringify(plan.request.target)))return fail('EVIDENCE_MISMATCH');
   const turn=turns.find(item=>item.id===turnId);
   if(!turn)return fail('EVIDENCE_MISMATCH');
   const entry=state.data.entries.find(item=>item.turnId===turnId);if(!entry)return fail('INTENT_NOT_FOUND');
   const read=EvidenceStorageResultSchema.parse(await this.dependencies.storage.execute({action:'read',runId,turnId}));
   if(!read.success||read.data.kind!=='read')return fail('STORAGE_FAILED');
   const matches=(artifact:import('./sprint4-evidence.spec.js').TerminalArtifact)=>artifact.payload.planHash===terminalEvidenceHash(plan)&&
    JSON.stringify(artifact.payload.admission)===JSON.stringify(entry.admission)&&artifact.payload.observation.binding.runId===runId&&
    artifact.payload.observation.binding.turnId===turnId&&artifact.payload.observation.input.text===turn.input;
   if(read.data.artifact){
    if(!matches(read.data.artifact))return fail('EVIDENCE_MISMATCH');
    return {success:true,data:{kind:'awaiting-review',source:'archive',artifact:read.data.artifact}};
   }
   const observed=TerminalAuditResultSchema.parse(await this.dependencies.audit.execute({runId,turnId}));
   if(!observed.success)return {success:false,error:{code:'AUDIT_FAILED',auditCode:observed.error.code}};
   const payload=TerminalArtifactPayloadSchema.parse({kind:'sprint4-terminal-artifact-v1',planHash:terminalEvidenceHash(plan),admission:entry.admission,
    observation:observed.data,rawArtifact:{status:'unavailable',reason:'not-retained-by-runtime'}});
   const sha256=terminalEvidenceHash(payload),artifact=TerminalArtifactSchema.parse({ref:'terminal-sha256:'+sha256,sha256,payload});
   if(!matches(artifact))return fail('EVIDENCE_MISMATCH');
   const saved=EvidenceStorageResultSchema.parse(await this.dependencies.storage.execute({action:'archive-once',artifact}));
   if(!saved.success||saved.data.kind!=='archived')return fail('STORAGE_FAILED');
   const confirmed=EvidenceStorageResultSchema.parse(await this.dependencies.storage.execute({action:'read',runId,turnId}));
   if(!confirmed.success||confirmed.data.kind!=='read'||JSON.stringify(confirmed.data.artifact)!==JSON.stringify(artifact))return fail('STORAGE_FAILED');
   return {success:true,data:{kind:'awaiting-review',source:'captured',artifact}};
  }catch{return fail('DEPENDENCY_FAILED');}
 }
}
