(function(root){'use strict';
const DAY=86400000;
const normalize=t=>String(t??'').normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[^a-z0-9'\s]/g,' ').replace(/\s+/g,' ').trim();
const ordinal=(q,i=0)=>{let n=/[qQ](\d+)$/.exec(String(q.id||''));return n?Number(n[1])-1:i};
function identity(r,q,i=0){const original=r.items?.findIndex(item=>item.id===q.id);return r.module+':'+(r.group||r.id)+':'+(original>=0?original:ordinal(q,i))}
function schedule(previous={},correct,now=Date.now()){
 if(correct&&previous.lastCorrect===true&&Number.isFinite(previous.due)&&now<previous.due)return {...previous,lastReviewed:now,updated:now};
 const streak=correct?(previous.streak||0)+1:0;
 const interval=correct?[1,3,7,14,30,60][Math.min(streak-1,5)]:0;
 return {...previous,streak,interval,due:now+(correct?interval*DAY:10*60000),lastReviewed:now,lastCorrect:!!correct,updated:now};
}
function queue(history,catalog,state=[],now=Date.now()){
 const attempts=[...history].filter(h=>!h.preview&&Number.isFinite(h.finished)).sort((a,b)=>a.finished-b.finished),references=new Map(),rows=new Map();
 const reference=(record,qid)=>JSON.stringify([record,qid]);
 // Full attempts supply original positions even when only the catalog is loaded.
 // A focused attempt's result index is not its position in the source material.
 for(const h of attempts)for(const result of h.results||[]){const r=catalog.get(result.id);if(!r||h.focusItems?.[result.id]||result.focused)continue;for(let i=0;i<(result.items||[]).length;i++){const q=result.items[i];references.set(reference(result.id,q.id),identity(r,q,i))}}
 for(const row of state.filter(x=>x&&!x.conflictCopy&&x.id?.startsWith('review:'))){
  const r=catalog.get(row.record),i=r?.items?.findIndex(q=>q.id===row.qid),key=i>=0?identity(r,r.items[i],i):references.get(reference(row.record,row.qid))||row.id.slice(7),old=rows.get(key);
  if(!old||(row.updated||0)>=(old.updated||0))rows.set(key,{...row,id:'review:'+key});
  references.set(reference(row.record,row.qid),key);
 }
 for(const h of attempts)
  for(const result of h.results||[]){const r=catalog.get(result.id);if(!r)continue;
   for(let i=0;i<(result.items||[]).length;i++){const q=result.items[i];if(q.correct!==false||!(q.answered??!!String(q.response||'').trim()))continue;
    const original=r.items?.findIndex(item=>item.id===q.id),focused=h.focusItems?.[result.id]||result.focused;
    const key=original>=0?identity(r,r.items[original],original):references.get(reference(result.id,q.id))||(!focused||/[qQ]\d+$/.test(q.id)?identity(r,q,i):r.module+':'+(r.group||r.id)+':qid:'+q.id),old=rows.get(key)||{};
    references.set(reference(result.id,q.id),key);
    if((old.lastMiss||0)>h.finished)continue;
    rows.set(key,{...old,id:'review:'+key,record:r.key||result.id,qid:q.id,lastMiss:h.finished,lastAttempt:h.id,misses:(old.misses||0)+(old.lastMiss===h.finished?0:1),due:(old.lastReviewed||0)>=h.finished?old.due:h.finished,streak:(old.lastReviewed||0)>=h.finished?old.streak:0});
   }
  }
 return [...rows.values()].filter(x=>!x.disabled&&catalog.has(x.record)).map(x=>({...x,dueNow:!x.due||x.due<=now})).sort((a,b)=>Number(b.dueNow)-Number(a.dueNow)||(a.due||0)-(b.due||0)||(b.lastMiss||0)-(a.lastMiss||0));
}
function skill(r,q={}){
 const mod=r.module,type=(q.question_type||q.skill||'').toLowerCase();
 if(mod==='reading-t1')return 'word-forms';
 if(mod==='reading-t2'||mod==='reading-t3')return /vocab/.test(type)?'vocabulary':/infer|purpose|function/.test(type)?'reading-inference':'reading-evidence';
 if(mod==='listening-t1')return 'listening-intent';
 if(mod.startsWith('listening'))return /main|organiz|purpose/.test(type)?'listening-structure':'listening-details';
 return {'speaking-t1':'repeat','speaking-t2':'interview','writing-t1':'sentence','writing-t2':'email','writing-t3':'discussion'}[mod]||'reading-evidence';
}
const cards=[
 {id:'word-forms',subject:'reading',title:'补全单词：先判断词性与词形',summary:'把句子结构、上下文和已给字母放在一起判断。',steps:['找主干，判断空格需要名词、动词、形容词还是副词。','检查单复数、时态、主谓一致及常见词缀。','补全后读完整句，确认拼写和句意都成立。'],example:'The results were surprisingly consistent.\nwere 后是表语；surprisingly 修饰形容词 consistent。',check:{prompt:'The new library is easily ____ to all students.',choices:['access','accessible','accessibility'],answer:1,why:'be accessible to 是“对……可使用/可到达”；此处需要形容词作表语。'}},
 {id:'vocabulary',subject:'reading',title:'词义判断：把选项代回语境',summary:'熟悉的中文释义不一定适合这句话。',steps:['先用上下文概括目标词在此处表达的意思。','比较词性、褒贬和程度，排除不符合语境的词。','把候选词代回原句，检查逻辑与搭配。'],example:'The evidence is compelling.\n这里 compelling 表示“有说服力的”，不表示“强迫的”。',check:{prompt:'The proposal is feasible with our current budget. feasible 最接近：',choices:['practical','expensive','popular'],answer:0,why:'预算允许实施，因此 feasible 在这里接近 practical。'}},
 {id:'reading-evidence',subject:'reading',title:'阅读定位：区分原文与推测',summary:'选项需要有文本依据，注意同义改写与限定范围。',steps:['确定题目问谁、什么行为、哪个条件。','定位相关句，连同前后句一起读。','核对选项的对象、程度、时间和因果，避免过度推断。'],example:'Some students prefer online courses.\n只能推出“部分学生偏好线上课”，不能推出“多数学生更喜欢线上课”。',check:{prompt:'原文：Registration closes on Friday. Which is supported?',choices:['You can register on Saturday.','You should register before registration closes on Friday.','Every course begins on Friday.'],answer:1,why:'截止时间支持及时报名；没有提到所有课程的开课日期。'}},
 {id:'reading-inference',subject:'reading',title:'推断与目的：判断句子发挥的作用',summary:'推断应紧贴证据，目的题关注作者为什么写这句话。',steps:['先理解段落主旨与句间关系。','判断例子、对比、原因或让步在支持什么。','选证据足够支持的结论，保留可能、部分等限定。'],example:'The author describes an exception after presenting a general rule.\n这个例子可能用于限制规则的适用范围。',check:{prompt:'先介绍一种旧方法的不足，再介绍新方法，最可能的写作目的是什么？',choices:['解释为什么需要新方法','证明所有旧方法都无效','说明新方法已经被所有人接受'],answer:0,why:'这种组织可以说明改进动机，但不足以支持“所有”这样的绝对结论。'}},
 {id:'listening-intent',subject:'listening',title:'听句选答：识别说话意图',summary:'回答要回应对方真正要表达的内容。',steps:['判断对方是在请求、建议、邀请、抱怨还是询问信息。','抓住否定、转折、时间与委婉表达。','选择语用上自然的回应，避免只匹配相同词汇。'],example:'Could you give me a hand with these boxes?\n是在请求帮助，不是在询问身体部位。',check:{prompt:'“Would you mind closing the window?” 最自然的答复是：',choices:['Not at all. I’ll close it.','The window was expensive.','I bought it yesterday.'],answer:0,why:'回应了关窗的请求；Not at all 表示不介意。'}},
 {id:'listening-details',subject:'listening',title:'听力细节：捕捉修正与限制',summary:'最终决定常出现在转折、自我修正或补充条件之后。',steps:['记录人、时间、地点与任务，避免抄完整句。','听到 but、actually、instead 时更新前面的理解。','区分原计划、建议和最终安排。'],example:'We planned to meet on Tuesday, but Thursday works better.\n笔记应突出调整到 Thursday，而不是只记 Tuesday。',check:{prompt:'“The meeting was at two, but it has been moved to three.” 现在几点开会？',choices:['Two','Three','Not decided'],answer:1,why:'has been moved to three 表明会议已改到三点。'}},
 {id:'listening-structure',subject:'listening',title:'听力结构：用少量笔记保存关系',summary:'先抓主题与关系，再补关键例子。',steps:['用一句短语记录说话目的或讲座主题。','用箭头和缩写记录原因、对比、问题与解决方案。','判断例子支持哪一个观点，而不是只记例子名称。'],example:'Problem → proposed solution → limitation\n问题、方案、限制构成一条可复述的逻辑线。',check:{prompt:'讲者先定义一个概念，随后介绍两项实验，最值得记录的是：',choices:['所有冠词与介词','概念含义，以及每项实验支持或限制了什么','只记录实验名称'],answer:1,why:'记录概念与证据的关系，更有利于理解主旨和组织结构。'}},
 {id:'repeat',subject:'speaking',title:'听音复述：按意群保留完整信息',summary:'同时注意内容、词序、词形与清晰表达。',steps:['听时把短句组织成有意义的词组。','保留否定、数字、时态和关键内容词。','回听自己的录音，对照原句，选一处问题再录一次。'],example:'Please return the books / before the library closes.\n意群帮助保存信息，不代表考试会在斜线处暂停。',check:{prompt:'原句含 “should not”，复述成 “should”，主要改变了什么？',choices:['只改变标点','改变了否定意义','没有任何变化'],answer:1,why:'漏掉 not 会改变原意，不能只看大部分单词是否一致。'}},
 {id:'interview',subject:'speaking',title:'访谈回答：直接回应，再补具体细节',summary:'清楚回答题目的各个部分，并用相关细节展开。',steps:['先给出自己的回答，不用长篇引入。','用原因、经历或例子解释，再说明其意义。','回答有多个问题时逐项覆盖，保持自然表达。'],example:'I prefer studying in the library because it is quiet. Last week, I finished a difficult report there without interruptions.\n偏好、原因和具体经历相互支持。',check:{prompt:'题目问最近的一次购物及体验，哪个细节最能展开回答？',choices:['反复说购物很重要','说明买了什么、遇到了什么，以及为什么满意或不满意','背诵与购物无关的学习经历'],answer:1,why:'具体、相关的经历既回应问题，也提供有效展开。'}},
 {id:'sentence',subject:'writing',title:'组句：先找主干，再安放修饰成分',summary:'用语法关系决定词块位置。',steps:['先确定主语、谓语和必要的宾语或表语。','检查疑问、否定、从句和非谓语结构。','放入时间地点与其他修饰成分，通读检查词块数量。'],example:'Do you know / where the library is?\n嵌入式疑问从句通常使用陈述语序，而不是 where is the library。',check:{prompt:'Which sentence is correct?',choices:['Do you know where is the office?','Do you know where the office is?','Do you know where the office?'],answer:1,why:'where the office is 是嵌入式疑问从句，主语 the office 在系动词 is 前。'}},
 {id:'email',subject:'writing',title:'邮件：完成要点，并让对方知道下一步',summary:'任务完成、清楚组织与得体语气一起检查。',steps:['把题目要求拆成清单，写完逐项核对。','具体说明问题、原因或所需行动。','根据收件人调整语气，最后检查称呼与结束语。'],example:'Could we meet on Thursday afternoon to discuss the revised schedule?\n具体时间与目的让请求更容易得到回应。',check:{prompt:'给教授请求延长截止时间，哪种表达更得体清楚？',choices:['You must give me more time.','Could I submit the report on Monday? I need two extra days to verify the data.','More time. Thanks.'],answer:1,why:'明确提出请求、时间和理由，语气也适合对教授写信。'}},
 {id:'discussion',subject:'writing',title:'学术讨论：提出自己的观点与理由',summary:'回应讨论主题，并贡献清楚、有支持的论点。',steps:['用一句话明确自己的立场。','用原因、例子或后果展开，避免只重复他人。','可以回应已有观点，但应解释自己的补充。'],example:'I agree that public transport deserves investment. More reliable buses can help workers reach jobs that are otherwise difficult to access.\n后一句说明了为什么这项投资有价值。',check:{prompt:'哪种方式更能构成有效的讨论贡献？',choices:['完整复制另一位学生的帖子','说明自己的观点，再用相关例子解释','只写 I agree 三次'],answer:1,why:'观点与支持共同构成自己的贡献，不要求必须反对其他发言。'}}
];
function segments(r,q){
 if(r.module==='listening-t1')return (q?[q]:r.items).map(item=>{let i=r.items.findIndex(x=>x.id===item.id),range=r.audioRanges?.[i];return range&&r.audio?{audio:r.audio,start:range.start,end:range.end,text:(item.evidenceSentences||[]).map(x=>x.text).join(' '),question:item.id,number:i+1}:null}).filter(Boolean);
 return (r.transcriptSentences||[]).filter(x=>Number.isFinite(x.start)&&Number.isFinite(x.end)&&x.end>x.start&&x.text).map(x=>({audio:r.audio,start:x.start,end:x.end,text:x.text})).filter(x=>x.audio);
}
function wordCloze(word,examples){const forms=[...new Set([word.word,...(word.forms||[])])].filter(Boolean).sort((a,b)=>b.length-a.length),escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),rx=new RegExp('\\b(?:'+forms.map(escape).join('|')+')\\b','i');for(const source of examples||[]){let text=source.excerpt||source.context||'',match=text.match(rx);if(match)return {source,target:match[0],masked:text.replace(rx,'________')}}return null}
function diff(before,after){
 const a=String(before||'').match(/\S+/g)||[],b=String(after||'').match(/\S+/g)||[];
 if(a.length>800||b.length>800)return {before:a.map(text=>({text,changed:false})),after:b.map(text=>({text,changed:false})),limited:true};
 const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
 let i=0,j=0,left=[],right=[];while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){left.push({text:a[i++],changed:false});right.push({text:b[j++],changed:false})}else if(j<b.length&&(i===a.length||dp[i][j+1]>=dp[i+1][j]))right.push({text:b[j++],changed:true});else left.push({text:a[i++],changed:true})}return {before:left,after:right};
}
root.PracticeLearning={DAY,normalize,identity,ordinal,schedule,queue,skill,cards,segments,wordCloze,diff};
})(window);

(function(root){'use strict';
function dayKey(value){let d=new Date(value);return Number.isFinite(d.getTime())?[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-'):''}
function dayTime(day){return new Date(day+'T12:00:00').getTime()}
function shiftDay(day,step){let d=new Date(dayTime(day));d.setDate(d.getDate()+step);return dayKey(d)}
function vocabulary(groups,state,now=Date.now()){
 let mastered=0,reviewing=0,due=0;
 for(let w of groups){let xs=[...new Set([w.word,...(w.forms||[])])].map(k=>state[k]).filter(Boolean),canonical=state[w.word],known=typeof canonical?.mastered==='boolean'?canonical.mastered:xs.some(x=>x.mastered),seen=xs.some(x=>typeof x.mastered==='boolean'||Number.isFinite(x.lastReviewed));
  if(known)mastered++;else if(seen)reviewing++;
  if(xs.some(x=>Number.isFinite(x.due)&&x.due<=now))due++;
 }
 return {total:groups.length,mastered,reviewing,unseen:groups.length-mastered-reviewing,due};
}
function summarize(attempts,learning,groups,state,range='90',now=Date.now()){
 let today=dayKey(now),seen=new Set(),history=attempts.filter(h=>!h.preview&&!h.conflictCopy&&Number.isFinite(h.finished)&&h.finished<=now&&(!h.id||!seen.has(h.id)&&seen.add(h.id))).sort((a,b)=>a.finished-b.finished),logs=learning.filter(x=>x.type==='progress'&&!x.disabled&&/^\d{4}-\d{2}-\d{2}$/.test(x.day)&&Number.isFinite(x.at)&&x.at<=now),allDays=new Map();
 const day=key=>{if(!allDays.has(key))allDays.set(key,{key,answers:0,words:new Set(),knowledge:new Set(),seconds:0});return allDays.get(key)};
 for(let h of history){let d=day(dayKey(h.finished));d.seconds+=Number.isFinite(h.elapsed)?Math.max(0,Math.min(h.elapsed,86400)):0;for(let r of h.results||[])for(let q of r.items||[]){let oral=String(r.id).startsWith('speaking-'),answered=h.recorded?.[r.id+':'+q.id]||(!oral&&(q.answered??(Array.isArray(q.response)?q.response.length>0:!!String(q.response||'').trim())));if(answered)d.answers++}}
 let snapshots=new Map();for(let row of logs){let d=day(row.day);for(let word of Object.keys(row.words||{}))if(row.words[word])d.words.add(word);for(let id of Object.keys(row.knowledge||{}))if(row.knowledge[id])d.knowledge.add('knowledge:'+id);if(Number.isInteger(row.mastered)&&Number.isInteger(row.total)&&row.mastered>=0&&row.mastered<=row.total){let old=snapshots.get(row.day);if(!old||row.at>old.at)snapshots.set(row.day,row)}}
 for(let row of learning)if(row.id?.startsWith('knowledge:')&&Number.isFinite(row.lastReviewed)&&row.lastReviewed<=now)day(dayKey(row.lastReviewed)).knowledge.add(row.id);
 let active=[...allDays.values()].filter(d=>d.answers||d.words.size||d.knowledge.size).map(d=>d.key).sort(),first=[history[0]&&dayKey(history[0].finished),...active,...snapshots.keys()].filter(Boolean).sort()[0]||today;
 let start=range==='all'?first:shiftDay(today,-(range==='30'?29:89)),calendarStart=start<shiftDay(today,-364)?shiftDay(today,-364):start,days=[];
 for(let key=calendarStart;key<=today;key=shiftDay(key,1)){let d=allDays.get(key);days.push({key,answers:d?.answers||0,words:d?.words.size||0,knowledge:d?.knowledge.size||0})}
 let activity=active.filter(key=>key>=start&&key<=today),inPeriod=[...allDays.values()].filter(d=>d.key>=start&&d.key<=today),current=0,best=0,run=0,previous;
 for(let key of active){run=previous&&shiftDay(previous,1)===key?run+1:1;best=Math.max(best,run);previous=key}let end=active.at(-1);if(end===today||end===shiftDay(today,-1)){for(let key=end;active.includes(key);key=shiftDay(key,-1))current++}
 let scoreStart=history.map(h=>dayKey(h.finished)).find(day=>day>=start)||today,length=Math.max(1,Math.round((dayTime(today)-dayTime(scoreStart))/86400000)+1),bins=Math.min(12,length),subjects=Object.fromEntries(['reading','listening','speaking','writing'].map(k=>[k,{answers:0,materials:new Set(),correct:0,total:0,aiSum:0,aiCount:0,pending:0,points:Array.from({length:bins},()=>({correct:0,total:0,aiSum:0,aiCount:0}))}]));
 for(let h of history){let key=dayKey(h.finished);if(key<start)continue;let bin=Math.min(bins-1,Math.floor(Math.max(0,(dayTime(key)-dayTime(scoreStart))/86400000)/length*bins));for(let r of h.results||[]){let sub=subjects[String(r.id).split('-')[0]];if(!sub)continue;let p=sub.points[bin],items=r.items||[];sub.materials.add(r.id);for(let q of items){let oral=String(r.id).startsWith('speaking-'),answered=h.recorded?.[r.id+':'+q.id]||(!oral&&(q.answered??!!String(q.response||'').trim()));if(answered)sub.answers++;if(q.correct===null||q.correct===undefined&&r.automatic===false){let score=h.ai?.[r.id]?.[q.id]?.score;if(typeof score==='number'&&Number.isFinite(score)&&score>=0&&score<=5){sub.aiSum+=score;sub.aiCount++;p.aiSum+=score;p.aiCount++}else if(answered)sub.pending++}}
   if(r.automatic!==false&&Number.isFinite(r.correct)&&Number.isFinite(r.total)&&r.total>0&&r.correct>=0&&r.correct<=r.total){sub.correct+=r.correct;sub.total+=r.total;p.correct+=r.correct;p.total+=r.total}
  }}
 for(let sub of Object.values(subjects)){sub.materials=sub.materials.size;sub.accuracy=sub.total?sub.correct/sub.total*100:null;sub.ai=sub.aiCount?sub.aiSum/sub.aiCount:null;sub.points=sub.points.map(p=>({accuracy:p.total?p.correct/p.total*100:null,ai:p.aiCount?p.aiSum/p.aiCount:null}))}
 let vocab=vocabulary(groups,state,now),wordTrend=[...snapshots.values()].filter(x=>x.day>=start&&Number.isInteger(x.mastered)&&x.mastered>=0&&x.mastered<=x.total).sort((a,b)=>a.day.localeCompare(b.day)).map(x=>({day:x.day,value:x.mastered}));
 return {start,today,days,calendarTruncated:calendarStart!==start,activeDays:activity.length,currentStreak:current,bestStreak:best,answers:inPeriod.reduce((n,d)=>n+d.answers,0),seconds:inPeriod.reduce((n,d)=>n+d.seconds,0),reviewedWords:inPeriod.reduce((n,d)=>n+d.words.size,0),subjects,vocab,wordTrend};
}
root.PracticeProgress={dayKey,shiftDay,vocabulary,summarize};
})(window);
