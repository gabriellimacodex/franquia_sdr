import type { Config } from './config.js';
import { ServiceError } from './security.js';

/** Media ID only, never a user-provided URL. No raw audio persisted by this service. */
export async function transcribeAudio(mediaId:string,phoneNumberId:string,config:Pick<Config,'KAPSO_API_KEY'|'OPENAI_API_KEY'>,transport:typeof fetch=fetch):Promise<string> {
 if(!config.OPENAI_API_KEY) throw new ServiceError('TRANSCRIPTION_NOT_CONFIGURED',503);
 const meta=await transport(`https://api.kapso.ai/meta/whatsapp/v24.0/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(phoneNumberId)}`,{headers:{'X-API-Key':config.KAPSO_API_KEY},signal:AbortSignal.timeout(5000)});
 if(!meta.ok) throw new ServiceError('AUDIO_UNAVAILABLE');
 const metadata=await meta.json();
 let url:URL;
 try {url=new URL(metadata?.download_url);}catch{throw new ServiceError('AUDIO_NOT_ALLOWED');}
 if(url.origin!=='https://api.kapso.ai'||url.username||url.password||url.pathname!=='/meta/whatsapp/media_download'||Number(metadata.file_size)>12*1024*1024) throw new ServiceError('AUDIO_NOT_ALLOWED');
 const media=await transport(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
 if(!media.ok||!media.body) throw new ServiceError('AUDIO_UNAVAILABLE');
 const chunks:Uint8Array[]=[]; let size=0;
 for await(const chunk of media.body as unknown as AsyncIterable<Uint8Array>) {
  size+=chunk.length; if(size>12*1024*1024) throw new ServiceError('AUDIO_TOO_LARGE'); chunks.push(chunk);
 }
 const mime=String(metadata.mime_type??'audio/ogg').split(';')[0];
 const extension:Record<string,string>={'audio/ogg':'ogg','audio/mpeg':'mp3','audio/mp4':'m4a','audio/wav':'wav','audio/webm':'webm'};
 if(!extension[mime]) throw new ServiceError('AUDIO_TYPE_UNSUPPORTED');
 const form=new FormData(); form.set('model','gpt-4o-mini-transcribe');form.set('language','pt');form.set('file',new Blob(chunks.map(c=>new Uint8Array(c).buffer),{type:mime}),'audio.'+extension[mime]);
 const response=await transport('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+config.OPENAI_API_KEY},body:form,signal:AbortSignal.timeout(25000)});
 if(!response.ok) throw new ServiceError('TRANSCRIPTION_FAILED');
 const result=await response.json();
 if(typeof result.text!=='string'||!result.text.trim()) throw new ServiceError('TRANSCRIPTION_EMPTY');
 return result.text.slice(0,16000);
}
