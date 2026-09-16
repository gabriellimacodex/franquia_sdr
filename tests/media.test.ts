import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMedia } from '../src/media.js';
import { MEDIA_MODEL } from '../src/prompts.js';
import { ServiceError } from '../src/security.js';

const config={KAPSO_API_KEY:'synthetic-kapso',OPENAI_API_KEY:'synthetic-openai'};
const download='https://api.kapso.ai/meta/whatsapp/media_download?token=synthetic';
const isError=(code:string)=>(error:unknown)=>error instanceof ServiceError&&error.code===code;
const responses=(text:string)=>Response.json({output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text}]}]});

test('media rejects untrusted metadata before downloading and never calls the model',async()=>{
 for(const download_url of [undefined,'https://example.invalid/file','http://api.kapso.ai/meta/whatsapp/media_download']){
  let calls=0;
  await assert.rejects(describeMedia('media-1','phone-1','image',config,async()=>{calls++;return Response.json({download_url,mime_type:'image/jpeg'});}),isError('MEDIA_NOT_ALLOWED'));
  assert.equal(calls,1);
 }
});

test('image goes to the Responses API as a data URL with only the OpenAI credential; output is prefixed and captured',async()=>{
 let calls=0;
 const transport:typeof fetch=async(input,options)=>{
  calls++;
  if(calls===1){assert.equal(new Headers(options?.headers).get('X-API-Key'),config.KAPSO_API_KEY);return Response.json({download_url:download,mime_type:'image/png',file_size:3});}
  if(calls===2){assert.equal(String(input),download);assert.equal(options?.headers,undefined);return new Response(new Uint8Array([1,2,3]));}
  assert.equal(String(input),'https://api.openai.com/v1/responses');
  assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+config.OPENAI_API_KEY);
  assert.equal(new Headers(options?.headers).get('X-API-Key'),null);
  const body=JSON.parse(String(options?.body));
  assert.equal(body.model,MEDIA_MODEL);assert.equal(body.store,false);
  const part=body.input[0].content[1];
  assert.equal(part.type,'input_image');assert.ok(String(part.image_url).startsWith('data:image/png;base64,AQID'));
  return responses('Fachada de loja de açaí em um shopping.');
 };
 assert.equal(await describeMedia('media-1','phone-1','image',config,transport),'[Imagem] Fachada de loja de açaí em um shopping.');
 assert.equal(calls,3);
});

test('document requires PDF and is sent as an input_file; empty model output fails closed',async()=>{
 let calls=0;
 await assert.rejects(describeMedia('media-1','phone-1','document',config,async()=>{
  calls++;return calls===1?Response.json({download_url:download,mime_type:'application/msword',file_size:3}):new Response(new Uint8Array([1,2,3]));
 }),isError('MEDIA_TYPE_UNSUPPORTED'));
 assert.equal(calls,2);
 calls=0;
 const transport:typeof fetch=async(_input,options)=>{
  calls++;
  if(calls===1)return Response.json({download_url:download,mime_type:'application/pdf',file_size:3});
  if(calls===2)return new Response(new Uint8Array([1,2,3]));
  const part=JSON.parse(String(options?.body)).input[0].content[1];
  assert.equal(part.type,'input_file');assert.ok(String(part.file_data).startsWith('data:application/pdf;base64,'));
  return responses('Proposta de locação: sala 45 m² no Shopping Norte.');
 };
 assert.equal(await describeMedia('media-1','phone-1','document',config,transport),'[Documento] Proposta de locação: sala 45 m² no Shopping Norte.');
 await assert.rejects(describeMedia('media-1','phone-1','document',config,async(_input,options)=>{
  if(!options?.method)return Response.json({download_url:download,mime_type:'application/pdf',file_size:3});
  return responses('');
 }),isError('MEDIA_DESCRIPTION_EMPTY'));
});

test('an oversized stream is rejected even when metadata understates the size',async()=>{
 let calls=0;
 await assert.rejects(describeMedia('media-1','phone-1','image',config,async()=>{
  calls++;
  if(calls===1)return Response.json({download_url:download,mime_type:'image/jpeg',file_size:10});
  return new Response(new ReadableStream({start(controller){for(let i=0;i<13;i++)controller.enqueue(new Uint8Array(1024*1024));controller.close();}}));
 }),isError('MEDIA_TOO_LARGE'));
});
