import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from '../src/worker.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const origin='https://ap-fixture.invalid',token='a'.repeat(40),pdf=Buffer.from('%PDF-1.7\nOriginal anonymous shared AP PDF fixture\n%%EOF\n');
const pdfPath='/question-assets/ap/'+digest(pdf)+'.pdf',id='ap:synthetic-shared';
function fixture(chunked){
  const set={schemaVersion:2,id,revision:'b'.repeat(64),contentMode:'private',documents:[{asset:pdfPath.slice(1)}]},calls=[];
  const catalog={schemaVersion:1,htmlTemplates:{},protectedRoutes:{}};
  const values=new Map();
  for(const [route,value]of Object.entries({'/api/exams/ap/sources':{schemaVersion:2,exam:'ap',sources:[{id}]},['/api/exams/ap/sources/'+id]:set})){
    const asset='/_catalog/'+digest(route)+'.json';values.set(asset,Buffer.from(JSON.stringify(value)));catalog.protectedRoutes[route]={asset,contentType:'application/json'};
  }
  const record={bytes:pdf.length,sha256:digest(pdf),contentType:'application/pdf',byteRanges:true};
  if(chunked){record.chunks=[];record.chunkBytes=[];for(let i=0;i<pdf.length;i+=17){const name='/_catalog/chunks/pdf-'+i;const bytes=pdf.subarray(i,i+17);record.chunks.push(name);record.chunkBytes.push(bytes.length);values.set(name,bytes);}}
  else {record.asset='/_catalog/pdf.pdf';values.set(record.asset,pdf);}
  catalog.protectedRoutes[pdfPath]=record;values.set('/_catalog/routes.json',Buffer.from(JSON.stringify(catalog)));
  const env={AUTH:{getByName:()=>({fetch:async()=>Response.json({authenticated:true,user:{id:'fixture-user',role:'student'}})})},ASSETS:{fetch:async request=>{
    const url=new URL(typeof request==='string'?request:request.url);calls.push(url.pathname);
    const bytes=values.get(url.pathname);return bytes?new Response(bytes):new Response(null,{status:404});
  }}};
  async function get(path,{anonymous=false,method='GET',headers={}}={}){return worker.fetch(new Request(origin+path,{method,headers:{...(!anonymous?{Cookie:'study_session='+token}:{}),...headers}}),env);}
  return {get,calls,set};
}
for(const chunked of [false,true])test(`AP authenticated PDF ${chunked?'chunked':'single'} GET HEAD ranges and closed routes`,async()=>{
  const {get,calls,set}=fixture(chunked);
  assert.equal((await get(pdfPath,{anonymous:true})).status,404);assert.equal(calls.length,0);
  assert.equal((await get('/api/exams/ap/sources',{anonymous:true})).status,401);
  assert.equal((await get('/api/exams/ap/sources/'+encodeURIComponent(id),{anonymous:true})).status,401);
  const source=await get('/api/exams/ap/sources/'+encodeURIComponent(id));assert.equal(source.status,200);assert.deepEqual(await source.json(),set);
  assert.deepEqual(await (await get('/api/exams/ap/sources/'+id)).json(),set);
  for(const bad of ['ap%253Asynthetic-shared','ap%3Asynthetic%2Fshared','ap%3AUPPER','ap%3Asynthetic_shared','ap%3A..','ap%3Asynthetic%00','ap%3A'+ 'a'.repeat(121),'%'])assert.equal((await get('/api/exams/ap/sources/'+bad)).status,404,bad);
  for(const path of ['/_catalog/pdf.pdf','/local-data/question-banks/ap/private.json','/back-end/question-banks/ap/RESOURCE_MANIFEST.json','/question-assets/ap/'+ '0'.repeat(64)+'.pdf'])assert.equal((await get(path)).status,404,path);
  assert.equal((await get(pdfPath,{headers:{'X-Account-ID':'other'}})).status,409);
  const full=await get(pdfPath);assert.equal(full.status,200);assert.equal(full.headers.get('Content-Type'),'application/pdf');assert.equal(full.headers.get('Accept-Ranges'),'bytes');assert.match(full.headers.get('Cache-Control'),/no-store/);assert.equal(full.headers.get('Content-Length'),String(pdf.length));assert.deepEqual(Buffer.from(await full.arrayBuffer()),pdf);
  const head=await get(pdfPath,{method:'HEAD',headers:{Range:'bytes=0-4'}});assert.equal(head.status,200);assert.equal(head.headers.get('Content-Length'),String(pdf.length));assert.equal((await head.arrayBuffer()).byteLength,0);
  for(const [range,start,end]of [['bytes=0-4',0,4],['bytes=15-38',15,38],['bytes=21-',21,pdf.length-1],['bytes=-6',pdf.length-6,pdf.length-1],['bytes=0-999',0,pdf.length-1]]){
    const response=await get(pdfPath,{headers:{Range:range}});assert.equal(response.status,206,range);assert.equal(response.headers.get('Content-Range'),`bytes ${start}-${end}/${pdf.length}`);assert.deepEqual(Buffer.from(await response.arrayBuffer()),pdf.subarray(start,end+1));
  }
  for(const range of ['bytes=9-1','bytes=999-','bytes=-0','bytes=','items=0-5','bytes=0-1,3-4','bytes=99999999999999999999-']){
    const response=await get(pdfPath,{headers:{Range:range}});assert.equal(response.status,416,range);assert.equal(response.headers.get('Content-Range'),`bytes */${pdf.length}`);assert.equal((await response.arrayBuffer()).byteLength,0);
  }
  const stale=await get(pdfPath,{headers:{Range:'bytes=0-4','If-Range':'"different"'}});assert.equal(stale.status,200);assert.deepEqual(Buffer.from(await stale.arrayBuffer()),pdf);
  const current=await get(pdfPath,{headers:{Range:'bytes=0-4','If-Range':'"'+digest(pdf)+'"'}});assert.equal(current.status,206);assert.equal(await current.text(),'%PDF-');
});
