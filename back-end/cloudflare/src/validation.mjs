import categories from '../../../front-end/sat/data/question-categories.json' with {type:'json'};
import {fail} from './json-stream.mjs';
export const MiB=1024*1024, MAX_ENTITY=64*MiB, MAX_SETTINGS=256*1024, MAX_ACCOUNT=512*MiB;
export const settings=new Set(['appConfig','practiceDurationPreferences','customPracticeDurationSeconds','timingTargets','questionTimer']);
export const toeflKeys=new Set(['four.history.v1','four.drafts.v2','four.words.v1','four.learning.v1','t1lab.history.v1']);
export const object=v=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
export const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export const fields=(v,allowed)=>object(v)&&Object.keys(v).every(key=>allowed.includes(key));
export const identity=value=>{
  if(typeof value!=='string'||![...value].length||[...value].length>512||/[\x00-\x1f\x7f\ud800-\udfff/\\?#]/u.test(value)||['.','..','__proto__','constructor','prototype'].includes(value))fail('SAT 记录编号无效。',400,'invalid_sat_data');
  return value;
};
export const summaryFields=['id','practiceName','status','completedAt','savedAt','startedAt','totalQuestions','correctCount','incorrectCount','unansweredCount','ungradedCount','elapsedMs','durationSeconds','fullSAT','resumable','libraryCollectionId','section'];
const attemptFields=[...summaryFields,'standardTiming','questionSnapshots','untimed','allowOvertime','modules','moduleResults','finishReason','questionIds','sourceIds','remainingTimeMs','runtimeSnapshot','answers','archivedForCollectionId'];
// Keep only small validation projections. Opaque question text/images, module
// payloads and runtime answers still remain byte-for-byte in chunk storage.
export function satProjection(path){
  if(path.length<3)return true;
  if(path[0]!=='value')return false;
  const field=path[1];
  if(field==='questionSnapshots')return path.length===3||path.length===4&&['id','section'].includes(path[3]);
  if(field==='answers')return path.length===3||path.length===4&&['answered','correctness'].includes(path[3]);
  if(['modules','moduleResults'].includes(field))return false;
  if(field==='runtimeSnapshot'){
    if(path[2]==='activePractice')return path.length===3||path.length===4&&['id','questionIds'].includes(path[3])||path.length===5&&path[3]==='questionIds';
    if(path[2]==='questionStates')return path.length<=4;
    return path.length===3&&path[2]==='currentQuestion';
  }
  if(['questionSnapshot','sourceSnapshot'].includes(field))return path.length===3&&field==='questionSnapshot'&&path[2]==='id';
  // Only flat identity lists need descendants outside the shapes above.
  // Unknown top-level fields are retained as containers and rejected by fields().
  return ['questionIds','sourceIds'].includes(field)&&path.length===3;
}
const satFail=(s)=>fail(s,400,'invalid_sat_data');
export function validateSetting(key,value){
  let valid=false;
  if(key==='customPracticeDurationSeconds')valid=integer(value,60,3840);
  if(key==='appConfig')valid=fields(value,['moduleQuestionLimit','examTimerWarning'])&&integer(value.moduleQuestionLimit,1,100)&&['fixed','proportional'].includes(value.examTimerWarning);
  if(key==='questionTimer')valid=fields(value,['enabled','mode'])&&typeof value.enabled==='boolean'&&['up','down'].includes(value.mode);
  if(key==='practiceDurationPreferences'){
    valid=object(value)&&Object.keys(value).length<=5000;
    if(valid)for(const [key,n]of Object.entries(value)){identity(key);valid&&=integer(n,60,3840);}
  }
  if(key==='timingTargets'){
    const allowed=new Set(['__uncategorized__',...categories.categories.map(c=>c.id)]);
    valid=object(value)&&Object.entries(value).every(([k,n])=>allowed.has(k)&&integer(n,0,300));
  }
  if(!valid)satFail('SAT 设置值超出允许范围。');
  return {};
}
export function validateSAT(kind,id,body,size){
  identity(id);
  if(!['attempts','wrong-book','settings'].includes(kind)||kind==='settings'&&!settings.has(id))fail('SAT 数据类型不存在。',404);
  if(!fields(body,['value','revision','deleted','restore','mutationId'])||!integer(body.revision)||typeof body.mutationId!=='string'||!/^[A-Za-z0-9_.:-]{1,100}$/.test(body.mutationId))satFail('SAT 同步需要有效的版本和操作编号。');
  const deleted=Object.hasOwn(body,'deleted')?body.deleted:false,restore=Object.hasOwn(body,'restore')?body.restore:false,value=body.value;
  if(typeof deleted!=='boolean'||typeof restore!=='boolean'||deleted&&restore||kind==='settings'&&(deleted||restore))satFail('SAT 同步操作无效。');
  if(deleted&&value!=null)satFail('删除操作不能包含题目或作答内容。');
  if(size>(kind==='settings'?MAX_SETTINGS:MAX_ENTITY))fail('记录超过同步容量，请保留本机副本。',413,'sat_storage_limit');
  if(deleted)return {};
  if(kind==='settings')return validateSetting(id,value);
  if(kind==='wrong-book'){
    if(!fields(value,['questionId','addedAt','reason','sourceAttemptId','questionSnapshot','sourceSnapshot'])||value.questionId!==id||!integer(value.addedAt,1)||!['manual','incorrect'].includes(value.reason)||!object(value.questionSnapshot)||value.questionSnapshot.id!==id||value.sourceSnapshot!=null&&!object(value.sourceSnapshot))satFail('错题本记录字段或快照无效。');
    if(value.sourceAttemptId!=null)identity(value.sourceAttemptId);
    return {};
  }
  if(!fields(value,attemptFields)||value.id!==id||!['completed','incomplete'].includes(value.status))satFail('练习记录字段、编号或状态无效。');
  const ids=value.questionIds,snapshots=value.questionSnapshots,answers=value.answers;
  if(!Array.isArray(ids)||!integer(ids.length,1,10000))satFail('练习需要 1–10000 个题目编号。');
  ids.forEach(identity);
  if(new Set(ids).size!==ids.length||value.totalQuestions!==ids.length||!Array.isArray(snapshots)||snapshots.length!==ids.length||snapshots.some((q,i)=>!object(q)||q.id!==ids[i])||!object(answers)||Object.keys(answers).length!==ids.length||ids.some(id=>!object(answers[id])))satFail('题目、快照和作答不一致。');
  const counts=['correctCount','incorrectCount','unansweredCount','ungradedCount'].map(k=>value[k]),actual=[0,0,0,0];
  for(const a of Object.values(answers)){
    if(typeof a.answered!=='boolean'||a.correctness!=null&&typeof a.correctness!=='boolean')satFail('作答状态无效。');
    actual[!a.answered?2:a.correctness==null?3:a.correctness?0:1]++;
  }
  if(counts.some((c,i)=>!integer(c,0,ids.length)||c!==actual[i]))satFail('练习统计与提交作答不一致。');
  if(typeof value.practiceName!=='string'||![...value.practiceName].length||[...value.practiceName].length>500)satFail('练习名称需为 1–500 个字符。');
  for(const name of ['libraryCollectionId','archivedForCollectionId'])if(value[name]!=null)identity(value[name]);
  for(const name of ['section','finishReason'])if(name in value&&(typeof value[name]!=='string'||[...value[name]].length>80))satFail('练习科目或结束原因无效。');
  for(const name of ['startedAt','completedAt','savedAt'])if(name in value&&!integer(value[name],1))satFail('练习时间无效。');
  for(const name of ['elapsedMs','remainingTimeMs','durationSeconds'])if(name in value&&(typeof value[name]!=='number'||!Number.isFinite(value[name])||value[name]<0||value[name]>Number.MAX_SAFE_INTEGER))satFail('练习计时无效。');
  for(const name of ['fullSAT','standardTiming','untimed','allowOvertime','resumable'])if(name in value&&typeof value[name]!=='boolean')satFail('练习选项无效。');
  if(value.status==='completed'&&(value.resumable||value.runtimeSnapshot!=null||!integer(value.completedAt,1)))satFail('已完成的练习状态无效。');
  if(value.status==='incomplete'&&value.resumable){
    const r=value.runtimeSnapshot;
    if(!object(r)||!object(r.activePractice)||r.activePractice.id!==id||JSON.stringify(r.activePractice.questionIds)!==JSON.stringify(ids)||!Array.isArray(r.questionStates)||r.questionStates.length!==ids.length||r.questionStates.some(q=>!object(q))||'currentQuestion'in r&&!integer(r.currentQuestion,0,ids.length-1))satFail('可继续的练习缺少完整的运行快照。');
  }
  if('sourceIds'in value&&(!Array.isArray(value.sourceIds)||value.sourceIds.length>10000))satFail('练习来源无效。');
  for(const source of value.sourceIds||[])identity(source);
  const summary=Object.fromEntries(summaryFields.filter(k=>k in value).map(k=>[k,value[k]]));
  const sections=new Set(snapshots.map(q=>q.section).filter(s=>typeof s==='string'&&[...s].length<=80));
  if(sections.size===1)summary.section=[...sections][0];
  return summary;
}
export function validateHome(value){
  if(!fields(value,['plan','targets','preferences']))fail('首页设置字段不受支持。');
  if(Buffer.byteLength(JSON.stringify(value))>16*1024)fail('首页设置内容过大。',413);
  const result={...value};
  if('plan'in value&&(!fields(value.plan,['dailyGoal','note'])||!integer(value.plan.dailyGoal,1,500)||'note'in value.plan&&(typeof value.plan.note!=='string'||[...value.plan.note].length>500)))fail('学习计划无效。');
  if('preferences'in value&&(!fields(value.preferences,['reduceMotion'])||'reduceMotion'in value.preferences&&typeof value.preferences.reduceMotion!=='boolean'))fail('显示偏好无效。');
  if('targets'in value){
    if(!fields(value.targets,['toefl','sat']))fail('目标分数无效。');
    result.targets={};
    for(const[exam,keys,low,high,step]of[['toefl',['reading','listening','speaking','writing'],1,6,.5],['sat',['english','math'],200,800,10]]){
      const target=value.targets[exam];if(target==null){result.targets[exam]=null;continue;}
      if(!fields(target,[...keys,'total'])||keys.some(k=>typeof target[k]!=='number'||!Number.isFinite(target[k])||target[k]<low||target[k]>high||target[k]/step!==Math.round(target[k]/step)))fail('目标分数超出范围或分档不正确。');
      const clean=Object.fromEntries(keys.map(k=>[k,target[k]])),sum=keys.reduce((n,k)=>n+target[k],0);clean.total=exam==='toefl'?Math.floor(sum/2+.5)/2:sum;result.targets[exam]=clean;
    }
  }
  return result;
}
export function mergeTOEFL(key,incoming,stored,drafts){
  if(incoming.some(row=>!object(row)||typeof row.id!=='string'||![...row.id].length||[...row.id].length>200))fail('练习记录编号无效。');
  if(key==='four.drafts.v2'){
    const cancelled=new Map();
    for(const row of [...stored,...incoming])if(object(row)&&row.cancelled===true){
      if(typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,150}$/.test(row.id)||['cache','transcript','example'].includes(row.id)||!integer(row.cancelledAt,1))fail('取消练习编号或时间无效。');
      if(!cancelled.has(row.id))cancelled.set(row.id,{id:row.id,cancelled:true,cancelledAt:row.cancelledAt});
    }
    return [...incoming.filter(row=>!cancelled.has(row.id)),...cancelled.values()];
  }
  if(key==='four.history.v1'){
    const cancelled=new Set(drafts.filter(r=>object(r)&&r.cancelled===true).map(r=>r.id)),edits=new Map(incoming.map(r=>[r.id,r])),metadata=new Set(['ai','aiErrors','rubric','selfEvaluation']);
    const core=row=>Object.fromEntries(Object.entries(row).filter(([k])=>!metadata.has(k)));
    const equal=(a,b)=>{if(a===b)return true;if(typeof a!==typeof b||!a||!b)return false;if(Array.isArray(a)!==Array.isArray(b))return false;const ak=Object.keys(a),bk=Object.keys(b);return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));};
    return [...incoming.filter(r=>!cancelled.has(r.id)),...stored.filter(r=>object(r)&&cancelled.has(r.id)).map(row=>{const edit=edits.get(row.id);return edit&&equal(core(row),core(edit))?{...core(row),...Object.fromEntries(Object.entries(edit).filter(([k])=>metadata.has(k)))}:row;})];
  }
  return incoming;
}
