// Explicit opt-in, one synthetic essay; no production accounts or deployment.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {realAIBinding} from '../scripts/real-ai-binding.mjs';
import {apMessages,parseAP,eligibility} from '../src/ap-ai.mjs';
import {TEXT_MODEL} from '../src/toefl-ai.mjs';
if(!process.argv.includes('--confirm-remote-ai'))throw Error('Requires --confirm-remote-ai; consumes Cloudflare quota.');
const root=fileURLToPath(new URL('../../../',import.meta.url));
const source=JSON.parse(await readFile(resolve(root,'back-end/question-banks/ap/sets/english-language-2025-set-1-frq-a07213d3169c32bb74a9.json'),'utf8'));
const q=source.questions.find(q=>q.number===3);
const response='Embracing the present matters because we can act only now, but it should complement rather than replace planning. A student who worries continually about a final examination may neglect today\'s lesson. By concentrating on one practice problem, the student can discover a specific misconception and correct it before the examination. In this case, attention to the present changes an abstract fear into useful action. Yet living exclusively for today can undermine that benefit. A runner who trains at maximum effort every day may feel productive while accumulating injuries. Planning rest days requires sacrificing immediate satisfaction for future health. Thus Osaka\'s claim is persuasive when embracing the present means noticing and using current opportunities, not ignoring consequences. A schedule is valuable precisely because it helps us decide what deserves attention now. We should plan thoughtfully, then give the chosen task our full attention.';
const b={sourceId:source.id,revision:source.revision,questionId:q.id,response};
const e=eligibility(b,q);assert.equal(e.scorable,true);
const binding=await realAIBinding(root);
try{
 const started=Date.now();
 const reply=await binding.service(new Request('https://isolated/ai',{method:'POST',body:JSON.stringify({model:TEXT_MODEL,input:{messages:apMessages(b,q,e),response_format:{type:'json_object'},max_tokens:2600,temperature:0}})}));
 assert.equal(reply.status,200,'Real AI transport failed');
 const result=parseAP(await reply.json(),b,q,e);
 assert.equal(result.status,'scored','Audited textual question should permit synthetic scoring');
 assert.equal(result.total,Object.values(result.rows).reduce((sum,row)=>sum+row.score,0));
 const directory=resolve(root,'local-data/test-artifacts/ap-ai-real');await mkdir(directory,{recursive:true});
 await writeFile(resolve(directory,'synthetic-result.json'),JSON.stringify({elapsedMs:Date.now()-started,...result},null,2));
 console.log('REAL AP SYNTHETIC PASS',JSON.stringify({status:result.status,total:result.total,elapsedMs:Date.now()-started}));
}finally{await binding.dispose();}
