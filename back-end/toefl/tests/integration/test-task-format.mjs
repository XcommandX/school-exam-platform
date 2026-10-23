import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateTask,exportBank,importBank,version} from '../../content/task-format.mjs';
const bank=JSON.parse(await readFile(new URL('../../fixtures/anonymous-bank.json',import.meta.url),'utf8'));
for(const task of bank.records) assert.equal(validateTask({formatVersion:version,task}).task,task);
const doc=()=>({formatVersion:version,task:structuredClone(bank.records[0])});
for(const edit of [d=>d.task.password='forbidden',d=>d.task.items.push(d.task.items[0]),d=>d.task.items[0].missingLetters='wrong',d=>d.task.audio='../private.wav',d=>d.formatVersion='toefl-task/2',d=>d.task.items[0].response='student answer']){const d=doc();edit(d);assert.throws(()=>validateTask(d));}
let d={formatVersion:version,task:structuredClone(bank.records.find(r=>r.module==='reading-t2'))};d.task.items[0].answer='nonexistent';assert.throws(()=>validateTask(d),/choices/);
const root=await mkdtemp(path.join(tmpdir(),'toefl-format-'));
try{
 const dir=path.join(root,'tasks');assert.equal((await exportBank(bank,dir)).tasks,12);
 assert.deepEqual((await importBank(dir)).bank,bank,'all native content and metadata must round-trip losslessly');
 await assert.rejects(()=>exportBank(bank,dir),/EEXIST/,'exports never overwrite an existing authoring folder');
 const manifestPath=path.join(dir,'library.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8')),original=structuredClone(manifest);
 manifest.tasks[0].path='../private.json';await writeFile(manifestPath,JSON.stringify(manifest));await assert.rejects(()=>importBank(dir),/unsafe/);
 manifest.tasks[0]=original.tasks[0];manifest.tasks.push(original.tasks[0]);await writeFile(manifestPath,JSON.stringify(manifest));await assert.rejects(()=>importBank(dir),/duplicate/);
 await writeFile(manifestPath,JSON.stringify(original));let first=path.join(dir,original.tasks[0].path),saved=await readFile(first,'utf8'),file=JSON.parse(saved);file.task.id='different';await writeFile(first,JSON.stringify(file));await assert.rejects(()=>importBank(dir),/identity/);
 await rm(first);let outside=path.join(root,'outside.json');await writeFile(outside,saved);await symlink(outside,first);await assert.rejects(()=>importBank(dir),/symbolic/);
}finally{await rm(root,{recursive:true,force:true})}
console.log('PASS: 12 task types, lossless editable files, strict identities and answer checks, no personal answer fields, traversal/duplicate/symlink rejection, no overwrite.');
