import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from '../src/audio.js';
import { ServiceError } from '../src/security.js';

const config={KAPSO_API_KEY:'synthetic-kapso',OPENAI_API_KEY:'synthetic-openai'};
const download='https://api.kapso.ai/meta/whatsapp/media_download?token=synthetic';
const isError=(code:string)=>(error:unknown)=>error instanceof ServiceError&&error.code===code;

test('audio rejects invalid or untrusted metadata before downloading',async()=>{
 for(const download_url of [undefined,'not a url','http://api.kapso.ai/meta/whatsapp/media_download','https://example.invalid/audio','https://api.kapso.ai:444/meta/whatsapp/media_download','https://user:pass@api.kapso.ai/meta/whatsapp/media_download']){
  let calls=0;
  await assert.rejects(transcribeAudio('media-1','phone-1',config,async()=>{calls++;return Response.json({download_url,mime_type:'audio/ogg'});}),isError('AUDIO_NOT_ALLOWED'));
  assert.equal(calls,1);
 }
});

test('signed audio download receives no API credentials; transcription gets only the OpenAI credential',async()=>{
 let calls=0;
 const transport:typeof fetch=async(input,options)=>{
  calls++;
  if(calls===1){
   assert.equal(new URL(String(input)).searchParams.get('phone_number_id'),'phone-1');
   assert.equal(new Headers(options?.headers).get('X-API-Key'),config.KAPSO_API_KEY);
   return Response.json({download_url:download,mime_type:'audio/ogg',file_size:3});
  }
  if(calls===2){assert.equal(String(input),download);assert.equal(options?.headers,undefined);assert.equal(options?.redirect,'error');return new Response(new Uint8Array([1,2,3]));}
  assert.equal(String(input),'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(new Headers(options?.headers).get('Authorization'),'Bearer '+config.OPENAI_API_KEY);
  assert.equal(new Headers(options?.headers).get('X-API-Key'),null);
  assert.equal((options?.body as FormData).get('model'),'gpt-4o-mini-transcribe');
  return Response.json({text:'Tenho interesse em uma franquia.'});
 };
 assert.equal(await transcribeAudio('media-1','phone-1',config,transport),'Tenho interesse em uma franquia.');
 assert.equal(calls,3);
});

test('audio enforces actual stream size even when metadata understates it',async()=>{
 let calls=0;
 await assert.rejects(transcribeAudio('media-1','phone-1',config,async()=>{
  calls++;
  return calls===1?Response.json({download_url:download,mime_type:'audio/ogg',file_size:1}):new Response(new Uint8Array(12*1024*1024+1));
 }),isError('AUDIO_TOO_LARGE'));
 assert.equal(calls,2);
});

test('audio without a transcription credential performs no external calls',async()=>{
 await assert.rejects(transcribeAudio('media-1','phone-1',{KAPSO_API_KEY:'synthetic'},async()=>{assert.fail('Unexpected request');}),isError('TRANSCRIPTION_NOT_CONFIGURED'));
});
