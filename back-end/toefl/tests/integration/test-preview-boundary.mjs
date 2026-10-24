import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../../scripts/preview.mjs';

const server = createPreviewServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = 'http://127.0.0.1:' + server.address().port;
try {
  const html = await fetch(base).then(r => r.text());
  assert(html.includes('本地匿名样例'));
  const data = await fetch(base + '/four-data.js').then(r => r.text());
  assert(data.includes('ANONYMOUS_FIXTURE'));
  assert.equal((await fetch(base + '/audio/fixture-tone.wav')).headers.get('Content-Type'), 'audio/wav');
  for (const route of ['/src/worker.mjs', '/cloud-client.js', '/clients/cloud-client.js', '/templates/accounts.html',
    '/integration/entry-links.mjs', '/AGENTS.md', '/.env', '/%2e%2e%2fsource-snapshot.json', '/%5c..%5c.env', '/audio/']) {
    assert.equal((await fetch(base + route)).status, 404, route);
  }
  assert.equal((await fetch(base + '/api/me')).status, 503);
  assert.equal((await fetch(base + '/', { method: 'POST', body: 'data' })).status, 405);
  assert.equal((await fetch(base + '/four-app.js', { method: 'HEAD' })).headers.get('Cache-Control'), 'no-store');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log('PASS: loopback preview exposes anonymous frontend only; no cloud routes, directories or source traversal.');

// An explicitly requested shared build has a separate output and never widens
// the unauthenticated anonymous preview's public file list.
const {mkdtemp,mkdir,writeFile,readFile,rm}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const path=(await import('node:path')).default;
const {createHash}=await import('node:crypto');
const {buildShared,distRoot,moduleRoot,frontEndRoot}=await import('../../scripts/build.mjs');
const temporary=await mkdtemp(path.join(tmpdir(),'toefl-shared-build-'));
try{
  const resourceRoot=path.join(temporary,'resources'),outputRoot=path.join(temporary,'output');
  await mkdir(path.join(resourceRoot,'audio'),{recursive:true});await mkdir(path.join(resourceRoot,'images'));
  const bank=JSON.parse(await readFile(path.join(moduleRoot,'fixtures/anonymous-bank.json'),'utf8'));
  for(const record of bank.records)record.source='JIJING';
  bank.fixture=false;
  const entries=[['bank.json',JSON.stringify(bank)],['audio/fixture-tone.wav','synthetic audio'],['images/fixture-scene.svg',await readFile(path.join(moduleRoot,'fixtures/anonymous-scene.svg'))]];
  const files=[];
  for(const [name,content]of entries){const bytes=Buffer.from(content);await writeFile(path.join(resourceRoot,name),bytes);files.push({path:name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
  const counts={records:bank.records.length,questions:bank.records.reduce((total,record)=>total+record.items.length,0),audio:1,images:1};
  await writeFile(path.join(resourceRoot,'RESOURCE_MANIFEST.json'),JSON.stringify({schema_version:1,kind:'toefl-shared-bank',bank:'bank.json',source:{kind:'synthetic-test'},counts,files}));
  const anonymous=await readFile(path.join(distRoot,'preview/four-data.js'));
  const shared=await buildShared({resourceRoot,outputRoot});
  assert.equal(shared.records,counts.records);assert.equal(shared.questions,counts.questions);
  assert.deepEqual(await readFile(path.join(shared.preview,'four-app.js')),await readFile(path.join(frontEndRoot,'four-app.js')),'shared build retains the production source filter');
  assert((await readFile(path.join(shared.preview,'four-data.js'),'utf8')).includes('JIJING'));
  assert(!(await readFile(path.join(shared.preview,'index.html'),'utf8')).includes('本地匿名样例'));
  assert.deepEqual(await readFile(path.join(distRoot,'preview/four-data.js')),anonymous,'shared content must never replace the anonymous preview');
  await assert.rejects(readFile(path.join(shared.preview,'cloud-client.js')));
  await writeFile(path.join(resourceRoot,'audio/fixture-tone.wav'),'corrupted');
  await assert.rejects(buildShared({resourceRoot,outputRoot}),/byte size|SHA-256/);
}finally{await rm(temporary,{recursive:true,force:true})}
console.log('PASS: opt-in shared builds validate resources, retain native task filtering, and cannot replace or expose anonymous preview/cloud client content.');
