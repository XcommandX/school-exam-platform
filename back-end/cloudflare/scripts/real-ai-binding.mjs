// Local-only bridge. Wrangler manages OAuth; credentials never enter our worker or logs.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
const models=new Set(['@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/openai/whisper-large-v3-turbo']);
export async function realAIBinding(root){
  const directory=resolve(root,'local-data/ai-real-preview');await mkdir(directory,{recursive:true});
  const configPath=resolve(directory,'wrangler-ai.generated.json');
  // This generated, non-secret file is owned by this script, never a user config.
  await writeFile(configPath,JSON.stringify({name:'school-local-ai-test',compatibility_date:'2026-10-20',ai:{binding:'AI',remote:true},observability:{enabled:false}}));
  const proxy=await getPlatformProxy({configPath,persist:false,envFiles:[],remoteBindings:true});
  // Hard per-process budget; errors count too, and browser requests cannot reset it.
  let calls=0;
  return {dispose:()=>proxy.dispose(),service:async request=>{
    const {model,input}=await request.json();
    if(!models.has(model)||calls>=6)return Response.json({error:'Local real-AI test limit reached.'},{status:429});
    calls++;
    console.log(JSON.stringify({event:'real-ai-call',number:calls,model}));
    try{const result=await proxy.env.AI.run(model,input);if(process.argv.includes('--synthetic-debug'))await writeFile(resolve(directory,`synthetic-result-${calls}.json`),JSON.stringify(result,null,2));return Response.json(result);}
    catch(error){console.error(JSON.stringify({event:'real-ai-error',number:calls,name:error?.name,category:/quota|3036/i.test(String(error?.message))?'quota':/auth|permission|401|403/i.test(String(error?.message))?'authorization':'provider_failure'}));return Response.json({error:'Remote AI call failed; check local diagnostic.'},{status:503});}
  }};
}
