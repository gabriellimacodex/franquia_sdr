import type { Config } from './config.js';
import { downloadKapsoMedia } from './audio.js';
import { MEDIA_MODEL } from './prompts.js';
import { ServiceError } from './security.js';

const IMAGE_TYPES=new Set(['image/jpeg','image/png','image/webp']);
const INSTRUCTION='Descreva em português, de forma factual e breve (até 120 palavras), o que este conteúdo mostra e que seja relevante para uma conversa sobre abrir uma franquia: texto legível, valores, locais, documentos, pessoas ou ambientes. Transcreva números e nomes exatamente como aparecem, sem interpretar nem completar. Se for um documento, resuma os pontos principais e cite o título. Não invente o que não estiver visível.';

/** Turns an image or PDF into candidate-authored text. Bytes go to OpenAI only and are never stored. */
export async function describeMedia(mediaId:string,phoneNumberId:string,kind:'image'|'document',config:Pick<Config,'KAPSO_API_KEY'|'OPENAI_API_KEY'>,transport:typeof fetch=fetch):Promise<string> {
 if(!config.OPENAI_API_KEY) throw new ServiceError('MEDIA_NOT_CONFIGURED',503);
 const {chunks,mime}=await downloadKapsoMedia(mediaId,phoneNumberId,config,transport,'MEDIA',kind==='image'?'image/jpeg':'application/pdf');
 if(kind==='image'?!IMAGE_TYPES.has(mime):mime!=='application/pdf') throw new ServiceError('MEDIA_TYPE_UNSUPPORTED');
 const data=`data:${mime};base64,${Buffer.concat(chunks.map(c=>Buffer.from(c))).toString('base64')}`;
 const part=kind==='image'?{type:'input_image',image_url:data,detail:'low'}:{type:'input_file',filename:'documento.pdf',file_data:data};
 const response=await transport('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+config.OPENAI_API_KEY,'Content-Type':'application/json'},
  body:JSON.stringify({model:MEDIA_MODEL,reasoning:{effort:'low'},max_output_tokens:400,store:false,input:[{role:'user',content:[{type:'input_text',text:INSTRUCTION},part]}]}),signal:AbortSignal.timeout(40000)});
 if(!response.ok) throw new ServiceError('MEDIA_DESCRIPTION_FAILED');
 const result=await response.json();
 type Part={type?:string,text?:string};
 const text=((result.output??[]) as {type?:string,content?:Part[]}[]).flatMap(item=>item.type==='message'?(item.content??[]):[])
  .filter(part=>part.type==='output_text').map(part=>part.text??'').join(' ').trim();
 if(!text) throw new ServiceError('MEDIA_DESCRIPTION_EMPTY');
 return `[${kind==='image'?'Imagem':'Documento'}] ${text}`.slice(0,4000);
}
