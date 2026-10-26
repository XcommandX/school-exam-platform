const assert = require('node:assert/strict');
const T = require('../../front-end/contests/timer.js');
const M = require('../../front-end/contests/model.js');
let checks = 0;
function test(name, run) { run(); checks++; console.log('PASS ' + name); }
function exam(contest = 'AMC10', year = 2026, count = contest === 'USAMO' ? year < 1996 ? 5 : 6 : contest === 'AIME' ? 15 : 25) {
  const id = `${contest.toLowerCase()}-${year}-a`;
  return {id, contest, year, revision:'a'.repeat(64), title:id, problems:Array.from({length:count}, (_,i) => ({id:id+'-'+(i+1),number:i+1,contest}))};
}
const make = (e=exam(), mode='private') => { const state=T.empty(); return {state,a:T.create(state,mode,e,'attempt-1',1000),e}; };
test('Modern AMC75 AIME180 USAMO270+270, exact question groups', () => {
  for (const name of ['AMC10','AMC12','AIME']) assert.equal(T.plan(exam(name),'private').sessions[0].minutes,name==='AIME'?180:75);
  const p=T.plan(exam('USAMO'),'private');
  assert.deepEqual(p.sessions.map(s=>[s.minutes,s.numbers]),[[270,[1,2,3]],[270,[4,5,6]]]);
  assert.equal(p.partial,false); assert.equal(p.historical,false);
});
test('Historical USAMO boundary years and SAME DAY 180-minute correction', () => {
  for (const year of [1972,1986,1989,1995]) {
    const p=T.plan(exam('USAMO',year),'private');
    assert.equal(p.sessions.length,1); assert.equal(p.sessions[0].minutes,210);
    assert.deepEqual(p.sessions[0].numbers,[1,2,3,4,5]); assert.equal(p.partial,false);
    if (year < 1989) { assert.equal(p.historical,false); assert.match(p.note,/不代表当年官方时限/); assert.match(p.note,/尚待逐年核实/); }
    else { assert.equal(p.historical,true); assert.match(p.note,/1989–1995 历史赛制/); }
  }
  for (const year of [1996,1997,2000,2001]) {
    const p=T.plan(exam('USAMO',year),'private');
    assert.deepEqual(p.sessions.map(s=>s.minutes),[180,180]);
    assert.ok(p.sessions.every(s=>s.label.includes('同日'))); assert.match(p.note,/同一天/);
  }
  assert.deepEqual(T.plan(exam('USAMO',2002),'private').sessions.map(s=>s.minutes),[270,270]);
});
test('Examples, incomplete banks and unverified early years labelled honestly', () => {
  assert.equal(T.plan(exam(),'example').partial,true);
  assert.equal(T.plan(exam('AIME',2026,3),'private').partial,true);
  assert.match(T.plan(exam('AMC12',1990),'private').note,/未逐年核实/);
  assert.match(T.plan(exam('USAMO',1970),'private').note,/现代标准/);
});
test('Explicit start only, absolute deadline survives JSON reload and background elapsed time', () => {
  const {state,a}=make(); assert.equal(a.sessions[0].status,'ready'); assert.equal(a.sessions[0].deadline,null);
  T.start(a,0,2000); assert.equal(a.sessions[0].deadline,4502000);
  const restored=T.load(JSON.parse(JSON.stringify(state))).attempts[0];
  assert.equal(T.remaining(restored.sessions[0],3000),4499000);
  assert.equal(T.reconcile(restored,4501999),false);
  assert.equal(T.reconcile(restored,4502000),true); assert.equal(restored.sessions[0].status,'expired');
  assert.equal(restored.sessions[0].endedAt,4502000); assert.equal(T.remaining(restored.sessions[0],9e9),0);
  assert.equal(T.reconcile(restored,9e9),false); assert.throws(()=>T.start(restored,0,9e9));
});
test('Write boundary rejects after deadline, non-running, foreign day, invalid clock', () => {
  const {a,e}=make(exam('USAMO')); assert.equal(T.write(a,0,e.problems[0],'no',1000),false);
  T.start(a,0,2000); assert.equal(T.write(a,0,e.problems[3],'wrong day',2001),false);
  assert.equal(T.write(a,0,e.problems[0],'proof',2001),true);
  assert.equal(T.write(a,0,e.problems[0],'bad clock',NaN),false);
  assert.equal(T.write(a,0,e.problems[0],'rollback',1999),false);
  assert.equal(T.write(a,0,e.problems[0],'too late',a.sessions[0].deadline),false);
  assert.equal(a.responses[e.problems[0].id].value,'proof'); assert.equal(a.sessions[0].status,'expired');
});
test('Manual finish immutable, next day independent and explicit', () => {
  const {a,e,state}=make(exam('USAMO')); assert.throws(()=>T.start(a,1,2000));
  T.start(a,0,2000); T.write(a,0,e.problems[0],'first',2001);
  assert.equal(T.finish(a,0,3000),true); const snapshot=JSON.stringify(a);
  assert.equal(T.write(a,0,e.problems[0],'overwrite',3001),false); assert.equal(T.finish(a,0,3002),false);
  assert.equal(JSON.stringify(a),snapshot); assert.equal(a.sessions[1].status,'ready');
  assert.equal(a.sessions[1].deadline,null); T.start(a,1,9000);
  assert.equal(a.sessions[1].deadline,9000+270*60000);
  assert.deepEqual(T.load(state),state);
});
test('New attempts archive old responses; no duplicates or overlapping same revision', () => {
  const {state,a,e}=make(); T.start(a,0,2000);
  assert.throws(()=>T.create(state,'private',e,'attempt-2',2001));
  T.write(a,0,e.problems[0],'B',2001); T.finish(a,0,3000);
  const next=T.create(state,'private',e,'attempt-2',4000); assert.deepEqual(next.responses,{});
  assert.equal(a.responses[e.problems[0].id].value,'B'); assert.throws(()=>T.create(state,'private',e,'attempt-1',5000));
});
test('Accounts modes revisions timed and untimed are isolated', () => {
  assert.notEqual(T.storageKey('a'),T.storageKey('b')); assert.notEqual(T.storageKey('a:b'),T.storageKey('a%3Ab')); assert.throws(()=>T.storageKey(''));
  const {state,a,e}=make(), regular=M.empty(), p=e.problems[0];
  M.updateResponse(regular,'private',e,p,{value:'ordinary'},1000);
  T.start(a,0,1000); T.write(a,0,p,'timed',2000);
  assert.equal(M.getSession(regular,'private',e).responses[p.id].value,'ordinary');
  assert.equal(T.create(state,'example',e,'example',2000).responses[p.id],undefined);
  assert.equal(T.create(state,'private',{...e,revision:'b'.repeat(64)},'revision',2000).responses[p.id],undefined);
  assert.equal(M.summarize(regular,'private',[e]).graded,0);
});
test('Unavailable partial day does not block next available day', () => {
  const e=exam('USAMO'); e.problems=e.problems.slice(3); const {a}=make(e);
  assert.equal(a.sessions[0].status,'unavailable'); T.start(a,1,2000); assert.equal(a.sessions[1].status,'running');
});
test('Invalid persisted deadline/state/response snapshots rejected without mutation', () => {
  const {state,a,e}=make(); T.start(a,0,2000); T.write(a,0,e.problems[0],'B',2001);
  const bad = mutation => {const copy=JSON.parse(JSON.stringify(state)); mutation(copy.attempts[0]); assert.throws(()=>T.load(copy));};
  bad(a=>a.sessions[0].deadline++); bad(a=>a.sessions[0].minutes=210.5);
  bad(a=>a.sessions[0].numbers.push(1)); bad(a=>a.key='other');
  bad(a=>a.responses[e.problems[0].id].updatedAt=a.sessions[0].deadline);
  bad(a=>a.sessions[0].status='ready'); bad(a=>a.id='__bad/id');
  bad(a=>a.responses=true); bad(a=>a.responses[e.problems[0].id].result='correct');
  bad(a=>a.responses[e.problems[0].id].revealed=true);
  const overlap=JSON.parse(JSON.stringify(state)); overlap.attempts.push({...overlap.attempts[0],id:'second-active'}); assert.throws(()=>T.load(overlap));
  assert.throws(()=>T.load({version:0,attempts:[]}));
  const copy=T.load(state); copy.attempts[0].responses[e.problems[0].id].value='changed';
  assert.equal(a.responses[e.problems[0].id].value,'B');
});
test('More than 500 archived attempts preserved without truncation', () => {
  const state=T.empty(),e=exam();
  for(let i=0;i<501;i++){const a=T.create(state,'private',e,'a-'+i,i*100);T.start(a,0,i*100);T.finish(a,0,i*100+1);}
  assert.equal(T.load(state).attempts.length,501);
});
console.log(`Contest timer: ${checks} groups passed.`);
