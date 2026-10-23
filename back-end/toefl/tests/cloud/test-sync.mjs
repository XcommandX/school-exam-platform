import assert from'node:assert/strict';import fs from'node:fs';import vm from'node:vm';let src=fs.readFileSync(new URL('./cloud-client.js',import.meta.url),'utf8');let a=src.indexOf('function merge('),b=src.indexOf('function lockPrivate(',a);let c={};vm.createContext(c);vm.runInContext(src.slice(a,b)+';this.merge=merge',c);let base=[{id:'a',answer:1}],remote=[{id:'a',answer:1},{id:'b',answer:2}];let r=c.merge('four.drafts.v2',[{id:'a',answer:3}],remote,base);assert.equal(r.length,2);assert.equal(r.find(x=>x.id==='a').answer,3);assert.ok(r.some(x=>x.id==='b'));r=c.merge('four.drafts.v2',[],remote,base);assert.equal(r.length,1);assert.equal(r[0].id,'b');r=c.merge('four.history.v1',[{id:'a',answer:3}],[{id:'a',answer:4}],base);assert.equal(r.length,2);assert.ok(r.some(x=>x.conflictCopy));r=c.merge('four.words.v1',{word:{note:'本机'}},{word:{note:'另一台'}},{word:{note:'原笔记'}});assert.match(r.word.note,/本机/);assert.match(r.word.note,/另一台/);console.log('PASS: other-device records retained, ended drafts removed without deleting unrelated drafts, conflicting attempts and word notes preserved.');

// Cancellation is durable per draft ID, including against clients that kept an
// active copy before cancellation. Its payload must not retain answer data.
const live={id:'cancel-me',values:{answer:'original'}},edited={id:'cancel-me',values:{answer:'remote edit'}};
const other={id:'keep-me',values:{answer:'independent original'}},otherEdited={id:'keep-me',values:{answer:'independent edit'}};
const cancelled={...live,cancelled:true,cancelledAt:1700000000000,recordings:['old-audio']};
const cases=[
 {name:'local cancellation beats a concurrent remote edit',local:[cancelled,other],remote:[edited,otherEdited],base:[live,other]},
 {name:'remote cancellation beats a concurrent local edit',local:[edited,other],remote:[cancelled,otherEdited],base:[live,other]},
 {name:'baseline cancellation beats two stale active copies',local:[live,other],remote:[edited,otherEdited],base:[cancelled,other]},
 {name:'baseline tombstone survives omission by both clients',local:[other],remote:[otherEdited],base:[cancelled,other]},
 ...[undefined,0,-1,Infinity,NaN].map(cancelledAt=>({name:'invalid cancellation timestamp '+String(cancelledAt),local:[{...cancelled,cancelledAt},other],remote:[edited,otherEdited],base:[live,other]}))
];
for(const test of cases){
 const merged=JSON.parse(JSON.stringify(c.merge('four.drafts.v2',test.local,test.remote,test.base)));
 assert.equal(merged.length,2,test.name+': preserve exactly the tombstone and the unrelated draft');
 const tombstone=merged.find(item=>item.id==='cancel-me');
 assert(tombstone,test.name+': keep the cancelled ID');
 assert.equal(tombstone.cancelled,true,test.name);
 assert.deepEqual(Object.keys(tombstone).sort(),['cancelled','cancelledAt','id'],test.name+': keep only a lightweight tombstone');
 assert(Number.isFinite(tombstone.cancelledAt)&&tombstone.cancelledAt>0,test.name+': normalize to a finite positive timestamp');
 assert(!merged.some(item=>item.conflictCopy||item.id.startsWith('cancel-me_conflict_')),test.name+': cancellation must not create an active conflict copy');
 assert.deepEqual(merged.find(item=>item.id==='keep-me'),otherEdited,test.name+': retain another draft and its remote edit');
}
// The cancellation rule belongs to drafts; history still preserves conflicts.
r=c.merge('four.history.v1',[{...cancelled,values:{answer:'local conflicting edit'}}],[edited],[live]);
assert.equal(r.length,2,'history must retain its original conflicting-record behavior');
assert(r.some(item=>item.conflictCopy&&item.values?.answer==='remote edit'),'history must preserve the remote conflicting payload');
console.log('PASS: draft cancellation tombstones beat concurrent and stale edits, survive baseline-only retention, stay lightweight, and leave history conflict handling unchanged.');
