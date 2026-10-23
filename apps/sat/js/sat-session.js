'use strict';
// SAT-only session planning. Question content and personal responses stay separate.
window.SATSession = (() => {
 const section = q => q?.section === 'Math' || q?.section === 'math' ? 'Math' : 'Reading and Writing';
 const isSPR = q => q?.responseType === 'student-produced-response';
 const answered = (q, response) => isSPR(q) ? !!response?.numericResponse?.trim() : Number.isInteger(response?.selectedOption);
 function grade(q, response) {
  if (q.packContent) return SATPack.grade(q, response);
  return !answered(q,response) ? null : response.selectedOption === q.correctOption;
 }
 function plan(questions, {source=null,durationSeconds=1920,questionLimit=30,fullSAT=false}={}) {
  if (!questions.length) throw new Error('Select at least one question.');
  const rw=questions.filter(q=>section(q)!=='Math'),math=questions.filter(q=>section(q)==='Math');
  if (fullSAT && (!rw.length || !math.length)) throw new Error('Full SAT Practice requires both Reading and Writing and Math questions.');
  const ordered=[...rw,...math],modules=[];
  let offset=0;
  for(const group of [rw,math]) {
   if(!group.length)continue;
   const subject=section(group[0]);
   const completeSource=!fullSAT && group.length===questions.length && source?.questionCount===questions.length
     && Array.isArray(source.moduleQuestionCounts) && source.moduleQuestionCounts.every(n=>Number.isInteger(n)&&n>0)
     && source.moduleQuestionCounts.reduce((a,b)=>a+b,0)===questions.length
     && questions.every((q,i)=>q.metadata?.sourceId===source.id&&q.metadata?.sourceQuestionIndex===i);
   const limit=fullSAT?Math.ceil(group.length/2):Math.max(1,questionLimit);
   const counts=completeSource?source.moduleQuestionCounts:Array.from({length:Math.ceil(group.length/limit)},(_,i)=>Math.min(limit,group.length-i*limit));
   counts.forEach((count,i)=>{const start=offset;offset+=count;modules.push({start,end:offset,section:subject,sectionNumber:subject==='Math'?2:1,moduleNumber:i+1,durationSeconds:fullSAT?(subject==='Math'?2100:1920):SATModel.clampDuration(completeSource?(source.moduleDurationsSeconds?.[i]??durationSeconds):durationSeconds)});});
  }
  return {questions:ordered,modules,fullSAT};
 }
 function answerLabel(q,response,correct=false) {
  if(isSPR(q))return correct?(q.answerRule?.status==='verified'?[...(q.answerRule.acceptedRationals||[]),...(q.answerRule.acceptedDecimalSpellings||[])].join(' or '):'Not verified'):(response?.numericResponse?.trim()||'—');
  const value=correct?q.correctOption:response?.selectedOption;
  return Number.isInteger(value)?'ABCD'[value]:'—';
 }
 return {section,isSPR,answered,grade,plan,answerLabel};
})();
