'use strict';
// Pure home-page calculations. No browser storage or original app data is read here.
(function (root) {
  const finite = v => typeof v === 'number' && Number.isFinite(v);
  const whole = v => finite(v) && v >= 0 ? Math.floor(v) : 0;
  const dayKey = value => {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : null;
  };
  function shiftDay(key, amount) {
    const [y,m,d] = key.split('-').map(Number);
    return dayKey(new Date(y,m-1,d+amount));
  }
  function validScore(v, min, max, step) {
    return finite(v) && v >= min && v <= max && Math.abs(v/step-Math.round(v/step)) < 1e-8;
  }
  function targets(value) {
    const t = value?.toefl;
    const s = value?.sat;
    const keys = ['reading','listening','speaking','writing'];
    const toefl = keys.every(k=>validScore(t?.[k],1,6,.5)) ? Object.fromEntries(keys.map(k=>[k,t[k]])) : null;
    if (toefl) toefl.total = Math.round(keys.reduce((n,k)=>n+toefl[k],0)/4*2)/2;
    const sat = ['english','math'].every(k=>validScore(s?.[k],200,800,10)) ? {english:s.english,math:s.math,total:s.english+s.math} : null;
    return {toefl,sat};
  }
  function summarize(satAttempts = [], toeflHistory = [], toeflLearning = [], now = Date.now()) {
    const rows = [];
    const seen = new Set();
    for (const a of satAttempts) {
      const finished = new Date(a.completedAt).getTime();
      if (a.status !== 'completed' || !finite(finished) || finished > now || (a.id && seen.has(`sat:${a.id}`))) continue;
      if (a.id) seen.add(`sat:${a.id}`);
      const answered = Math.max(0,whole(a.totalQuestions)-whole(a.unansweredCount));
      const graded = Math.max(0,answered-whole(a.ungradedCount));
      rows.push({exam:'sat',at:finished,answered,correct:Math.min(graded,whole(a.correctCount)),graded,name:a.practiceName || 'SAT 练习'});
    }
    for (const h of toeflHistory) {
      if (h.preview || h.conflictCopy || !finite(h.finished) || h.finished > now || (h.id && seen.has(`toefl:${h.id}`))) continue;
      if (h.id) seen.add(`toefl:${h.id}`);
      let answered=0,correct=0,graded=0;
      for (const r of h.results || []) for (const q of r.items || []) {
        const oral = String(r.id).startsWith('speaking-');
        const hasResponse = Boolean(h.recorded?.[`${r.id}:${q.id}`]) || (!oral && (q.answered ?? (Array.isArray(q.response) ? q.response.length > 0 : String(q.response ?? '').trim().length > 0)));
        if (hasResponse) answered++;
        if (hasResponse && typeof q.correct === 'boolean') {graded++;if(q.correct)correct++;}
      }
      rows.push({exam:'toefl',at:h.finished,answered,correct,graded,name:({reading:'TOEFL 阅读',listening:'TOEFL 听力',speaking:'TOEFL 口语',writing:'TOEFL 写作',full:'TOEFL 全科'})[h.subject] || 'TOEFL 练习'});
    }
    const today = dayKey(now), active = new Set(rows.filter(r=>r.answered>0).map(r=>dayKey(r.at)));
    for (const log of toeflLearning) {
      if (!finite(log.at) || log.at > now || log.type!=='progress' || log.disabled || log.day !== dayKey(log.at)) continue;
      if (Object.values(log.words || {}).some(Boolean) || Object.values(log.knowledge || {}).some(Boolean)) active.add(log.day);
    }
    let cursor = active.has(today) ? today : shiftDay(today,-1), streak=0;
    while (active.has(cursor)) {streak++;cursor=shiftDay(cursor,-1);}
    const total = exam => rows.filter(r=>!exam||r.exam===exam).reduce((v,r)=>({answers:v.answers+r.answered,correct:v.correct+r.correct,graded:v.graded+r.graded,attempts:v.attempts+1}),{answers:0,correct:0,graded:0,attempts:0});
    return {streak,today:rows.filter(r=>dayKey(r.at)===today).reduce((n,r)=>n+r.answered,0),all:total(),sat:total('sat'),toefl:total('toefl'),recent:rows.sort((a,b)=>b.at-a.at).slice(0,8)};
  }
  const api = Object.freeze({dayKey,shiftDay,targets,summarize});
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  else root.HomeModel=api;
})(typeof window !== 'undefined' ? window : globalThis);
