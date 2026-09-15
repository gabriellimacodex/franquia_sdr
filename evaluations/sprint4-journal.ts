import { DatabaseSync } from 'node:sqlite';
import { closeSync,constants,fsyncSync,lstatSync,openSync,readdirSync,realpathSync,type Stats } from 'node:fs';
import { dirname,isAbsolute,join } from 'node:path';
import { StoredControllerStateSchema, type CampaignJournal,type ControllerState,type StoredControllerState } from './sprint4-controller.spec.js';
import { Sprint4CampaignPlanner } from './sprint4-campaign.js';
import { JournalInputSchema,JournalOptionsSchema,type JournalResult,type JournalErrorCode,type Sprint4JournalSpec } from './sprint4-journal.spec.js';

class JournalFailure extends Error {constructor(readonly code:JournalErrorCode){super(code);}}
const filename='sprint4-journal.sqlite';
function privatePath(directory:string):string {
 if(!isAbsolute(directory)||typeof process.getuid!=='function')throw new JournalFailure('UNSAFE_STORAGE');
 const dir=lstatSync(directory),uid=process.getuid();
 if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==uid||(dir.mode&0o777)!==0o700)throw new JournalFailure('UNSAFE_STORAGE');
 for(const name of readdirSync(directory)){
  if(![filename,filename+'-journal'].includes(name))throw new JournalFailure('UNSAFE_STORAGE');
  try{const file=lstatSync(join(directory,name));if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.uid!==uid||(file.mode&0o777)!==0o600)throw new JournalFailure('UNSAFE_STORAGE');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 }
 return join(realpathSync(directory),filename);
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function validatedState(raw:unknown,runId:string,code:JournalErrorCode):StoredControllerState {
 const parsed=StoredControllerStateSchema.safeParse(raw);
 if(!parsed.success||!Number.isSafeInteger(parsed.data.revision)||!new Sprint4CampaignPlanner().validate(parsed.data.plan).success||parsed.data.plan.request.runId!==runId)throw new JournalFailure(code);
 const state=parsed.data,turns=state.plan.phases.flatMap(phase=>phase.executions.flatMap(execution=>execution.turns));
 if(state.entries.some((entry,index)=>{
  const intent='admission' in entry?entry.admission:entry.preflight;
  return entry.turnId!==turns[index]?.id||intent.turnId!==entry.turnId||!same(intent.target,state.plan.request.target)||
   entry.receipts.some(receipt=>receipt.turnId!==entry.turnId||receipt.requestId!==intent.requestId||receipt.sessionId!==intent.sessionId||!same(receipt.target,state.plan.request.target));
 }))throw new JournalFailure(code);
 return state;
}
function appendOnly(previous:ControllerState|null,next:ControllerState):boolean {
 if(next.revision!==(previous?.revision??0)+1)return false;
 if(!previous)return next.entries.length===1&&next.entries[0].receipts.length===0;
 if(!same(previous.plan,next.plan))return false;
 if(next.entries.length===previous.entries.length+1)return same(previous.entries,next.entries.slice(0,-1))&&next.entries.at(-1)!.receipts.length===0;
 if(next.entries.length!==previous.entries.length||!next.entries.length||!same(previous.entries.slice(0,-1),next.entries.slice(0,-1)))return false;
 const before=previous.entries.at(-1)!,after=next.entries.at(-1)!;
 return before.turnId===after.turnId&&same(before.admission,after.admission)&&after.receipts.length===before.receipts.length+1&&same(before.receipts,after.receipts.slice(0,-1));
}

/** Local POSIX storage only; no environment defaults, dispatch, reset or deletion API.
 * initializeNew is explicit and accepts only an empty private directory; reopening never creates a missing file.
 * SQLite EXTRA/DELETE + fullfsync confirm COMMIT before success; creation also fsyncs the directory.
 * Legacy payloads are read-only history, never upgraded or appended. Storage user_version stays 1;
 * the explicit v2 discriminator versions campaign intent, not the SQLite table format.
 * The bounded SQLite busy timeout waits for a storage lock, not a campaign retry. Hardware/filesystem
 * durability remains an OS contract; tests prove process-crash recovery, not power-loss tolerance. */
export class Sprint4Journal implements Sprint4JournalSpec {
 private db:DatabaseSync|undefined;private closed=false;private initialized=false;private identity:Stats|undefined;
 constructor(private readonly options:unknown){}
 async execute(raw:unknown):Promise<JournalResult>{
  let transaction=false;
  try{
   const input=JournalInputSchema.safeParse(raw),options=JournalOptionsSchema.safeParse(this.options);
   if(!input.success||!options.success)return {success:false,error:{code:'INVALID_INPUT'}};
   if(input.data.action==='close'){this.db?.close();this.db=undefined;this.closed=true;return {success:true,data:{kind:'closed'}};}
   if(this.closed)return {success:false,error:{code:'CLOSED'}};
   const path=privatePath(options.data.directory);
   if(!this.db){
    if(options.data.initializeNew){
     if(readdirSync(options.data.directory).length)throw new JournalFailure('UNSAFE_STORAGE');
     const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);try{fsyncSync(fd);}finally{closeSync(fd);}
    }
    privatePath(options.data.directory);this.identity=lstatSync(path);
    this.db=new DatabaseSync(path);
    if(!options.data.initializeNew&&(this.db.prepare('PRAGMA application_id').get()?.application_id!==1396986420||this.db.prepare('PRAGMA user_version').get()?.user_version!==1))throw new JournalFailure('CORRUPT_STATE');
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA busy_timeout=5000;');
    if(options.data.initializeNew){
     this.db.exec('BEGIN IMMEDIATE; CREATE TABLE revisions(run_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,revision)) STRICT; PRAGMA application_id=1396986420; PRAGMA user_version=1; COMMIT');
     const fd=openSync(dirname(path),constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}
    }
    if(this.db.prepare('PRAGMA application_id').get()?.application_id!==1396986420||this.db.prepare('PRAGMA user_version').get()?.user_version!==1||
     this.db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new JournalFailure('CORRUPT_STATE');
    this.initialized=true;
   }
   const current=lstatSync(path);
   if(current.dev!==this.identity?.dev||current.ino!==this.identity?.ino)throw new JournalFailure('UNSAFE_STORAGE');
   const command=input.data;
   if(command.action==='compare-and-swap'){this.db.exec('BEGIN IMMEDIATE');transaction=true;}
   const row=this.db.prepare('SELECT revision,payload FROM revisions WHERE run_id=? ORDER BY revision DESC LIMIT 1').get(command.runId);
   let state:StoredControllerState|null=null;
   if(row){try{state=validatedState(JSON.parse(row.payload as string),command.runId,'CORRUPT_STATE');if(state.revision!==row.revision)throw new Error();}catch{throw new JournalFailure('CORRUPT_STATE');}}
   if(command.action==='read')return {success:true,data:{kind:'read',state}};
   if(state&&!('protocol' in state)||!('protocol' in command.next))throw new JournalFailure('INVALID_TRANSITION');
   if((state?.revision??null)!==command.expectedRevision){this.db.exec('ROLLBACK');transaction=false;return {success:true,data:{kind:'compared',swapped:false}};}
   const next=validatedState(command.next,command.runId,'INVALID_TRANSITION');
   if(!('protocol' in next))throw new JournalFailure('INVALID_TRANSITION');
   if(!appendOnly(state,next))throw new JournalFailure('INVALID_TRANSITION');
   this.db.prepare('INSERT INTO revisions(run_id,revision,payload) VALUES(?,?,?)').run(command.runId,next.revision,JSON.stringify(next));
   this.db.exec('COMMIT');transaction=false;
   return {success:true,data:{kind:'compared',swapped:true}};
  }catch(error){
   if(transaction)try{this.db?.exec('ROLLBACK');}catch{
    // A failed rollback leaves transaction visibility uncertain. Never read it as durable history.
    this.closed=true;try{this.db?.close();this.db=undefined;}catch{/* Keep the handle quarantined; close can be retried explicitly. */}
   }
   if(!this.initialized){try{this.db?.close();}catch{/* Preserve the original failure. */}this.db=undefined;}
   return {success:false,error:{code:error instanceof JournalFailure?error.code:'STORAGE_FAILURE'}};
  }
 }
 asCampaignJournal():CampaignJournal {
  // The existing controller port has no Result failure case: reject, never translate storage errors to null/false.
  return {
   read:async runId=>{const result=await this.execute({action:'read',runId});if(!result.success)throw new Error(result.error.code);if(result.data.kind!=='read')throw new Error('STORAGE_FAILURE');return result.data.state;},
   compareAndSwap:async(runId,expectedRevision,next)=>{const result=await this.execute({action:'compare-and-swap',runId,expectedRevision,next});if(!result.success)throw new Error(result.error.code);if(result.data.kind!=='compared')throw new Error('STORAGE_FAILURE');return result.data.swapped;},
  };
 }
}
