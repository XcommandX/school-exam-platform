'use strict';
window.SATImporter = (() => {
  const optional=['passage','questionType','explanation','aiExplanation'];
  function validate(data) {
    const errors=[],warnings=[];
    if(!data || typeof data!=='object' || Array.isArray(data)) return {errors:['Expected a JSON object containing questions.'],questions:[]};
    if(!Array.isArray(data.questions)||!data.questions.length) return {errors:['questions must be a non-empty array.'],questions:[]};
    if(data.title!==undefined && typeof data.title!=='string') errors.push('title must be text.');
    if(data.section!==undefined && data.section!=='Reading and Writing') errors.push('Only Reading and Writing is supported.');
    if(data.moduleQuestionCounts!==undefined){
      const counts=data.moduleQuestionCounts;
      if(!Array.isArray(counts)||!counts.length||counts.some(n=>!Number.isInteger(n)||n<1)||counts.reduce((sum,n)=>sum+n,0)!==data.questions.length){
        errors.push('moduleQuestionCounts must contain positive integers that add up to the question count.');
      }
    }
    if(data.moduleDurationsSeconds!==undefined&&(!Array.isArray(data.moduleDurationsSeconds)||data.moduleDurationsSeconds.some(n=>!Number.isFinite(n)||n<60||n>3840)))errors.push('moduleDurationsSeconds must contain durations from 60 to 3840 seconds.');
    const normalized=data.questions.map((q,index)=>{
      const prefix=`Question ${index+1}: `;
      if(!q||typeof q!=='object'||Array.isArray(q)){errors.push(prefix+'must be an object.');return null;}
      if(typeof q.prompt!=='string'||!q.prompt.trim()) errors.push(prefix+'prompt missing.');
      if(!Array.isArray(q.options)||q.options.length!==4||q.options.some(v=>typeof v!=='string'||!v.trim())) errors.push(prefix+'options must contain 4 non-empty text choices.');
      const answer=typeof q.answer==='string'&&/^[A-D]$/.test(q.answer)?'ABCD'.indexOf(q.answer):q.answer;
      if(!Number.isInteger(answer)||answer<0||answer>3) errors.push(prefix+'answer must be A–D or an integer from 0 to 3.');
      optional.forEach(key=>{if(q[key]!==undefined&&typeof q[key]!=='string') errors.push(prefix+key+' must be text.');});
      let passage=q.passage??'',passageFormatting=[];
      try{if(q.passageMarkdown!==undefined){if(typeof q.passageMarkdown!=='string')throw new Error('passageMarkdown must be text.');const parsed=SATText.markdown(q.passageMarkdown);passage=parsed.text;passageFormatting=parsed.spans;}else passageFormatting=SATText.validate(q.passageFormatting,passage);}catch(e){errors.push(prefix+e.message);}
      let promptFormatting=[];
      try{promptFormatting=SATText.validate(q.promptFormatting,typeof q.prompt==='string'?q.prompt:'');}catch(e){errors.push(prefix+e.message.replace('passageFormatting','promptFormatting'));}
      let optionsFormatting=[];
      try{if(q.optionsFormatting!==undefined&&(!Array.isArray(q.optionsFormatting)||q.optionsFormatting.length!==4))throw new Error('optionsFormatting must have four arrays.');optionsFormatting=(q.options||[]).map((t,i)=>SATText.validate(q.optionsFormatting?.[i],t));}catch(e){errors.push(prefix+e.message);}
      if(q.passageStyle!==undefined&&!['prose','poetry','literary'].includes(q.passageStyle))errors.push(prefix+'Invalid passageStyle.');
      let visualStimulus=null;try{visualStimulus=SATModel.validateVisual(q.visualStimulus);}catch(e){errors.push(prefix+e.message);}
      const questionType=SATModel.category(q.questionType)?q.questionType:'';if(q.questionType&&!questionType)warnings.push(prefix+'Unknown question type; imported as Uncategorized.');
      if(q.answerProvenance!==undefined&&!['source','agent'].includes(q.answerProvenance))errors.push(prefix+'answerProvenance must be source or agent.');
      if(q.agentSuggestedAnswer!==undefined&&!/^[A-D]$/.test(q.agentSuggestedAnswer))errors.push(prefix+'agentSuggestedAnswer must be A–D.');
      const customMetadata=q.customMetadata??q.metadata??{};if(!customMetadata||typeof customMetadata!=='object'||Array.isArray(customMetadata))errors.push(prefix+'customMetadata must be an object.');
      return {customMetadata, ...(q.answerProvenance?{answerProvenance:q.answerProvenance}:{}),...(q.agentSuggestedAnswer?{agentSuggestedAnswer:q.agentSuggestedAnswer}:{}),visualStimulus,originalQuestionType:questionType?'':(q.questionType||''),passage,passageFormatting,passageStyle:q.passageStyle||'prose',prompt:q.prompt,promptFormatting,options:q.options,optionsFormatting,correctOption:answer,questionType,explanation:q.explanation??'',aiExplanation:q.aiExplanation??''};
    });

    return {errors,warnings,questions:normalized,title:data.title,section:'Reading and Writing',moduleQuestionCounts:data.moduleQuestionCounts,moduleDurationsSeconds:data.moduleDurationsSeconds,defaultDurationSeconds:SATModel.durationSeconds(data)};
  }
  async function preview(file,knownHashes=new Set()) {
    const result={fileName:file.name,count:0,errors:[],questions:[]};
    if(!/\.json$/i.test(file.name)) return {...result,errors:['.json files only.']};
    try {
      const text=await file.text();
      result.rawText=text;
      if(!text.trim()) return {...result,errors:['The file is empty.']};
      let data;try{data=JSON.parse(text);}catch{return {...result,errors:['Invalid JSON. Check the file syntax.']};}
      const validated=validate(data);Object.assign(result,validated);result.count=Array.isArray(data.questions)?data.questions.length:0;
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
      result.contentHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
      if(knownHashes.has(result.contentHash))result.errors.push('This question set has already been imported.');
      return result;
    }catch(error){return {...result,errors:['Could not read this file: '+error.message]};}
  }
  async function commit(preview) {
    if(preview.errors.length) throw new Error('Fix validation errors before importing.');
    const pack=preview.isSATPack?preview.packIdentity:null;
    if(preview.isSATPack&&(!pack||!preview.sourceId))throw new Error('A validated package identity is required.');
    const id=pack?preview.sourceId:crypto.randomUUID(),importedAt=Date.now();
    const source={id,fileName:preview.fileName,displayName:preview.title?.trim()||preview.fileName.replace(/\.json$/i,''),section:pack?preview.section:'Reading and Writing',importedAt,questionCount:preview.questions.length,defaultDurationSeconds:preview.defaultDurationSeconds||1920,moduleQuestionCounts:preview.moduleQuestionCounts||null,moduleDurationsSeconds:preview.moduleDurationsSeconds||null,bankFile:preview.bankFile||null,previousSourceId:preview.previousSourceId||null,contentHash:preview.contentHash,...(pack?{packIdentity:pack,responseType:preview.responseType}: {})};
    if(pack&&preview.collectionId)source.collectionId=preview.collectionId;
    // add(), rather than put(), protects attempts tied to a previous revision.
    // Re-importing changed content with an unchanged revision must fail.
    const normalized=preview.questions.map((q,index)=>({...q,id:pack?`${id}:${encodeURIComponent(q.itemId)}@${q.itemRevision}`:`${id}:${index}`,metadata:{sourceId:id,sourceFileName:source.fileName,sourceQuestionIndex:index,importedAt,originalQuestionType:q.originalQuestionType||'',...(pack?{itemId:q.itemId,itemRevision:q.itemRevision,packId:q.packId,packRevision:q.packRevision}:{})}}));
    await SATStorage.importSet(source,normalized);
    return normalized.length;
  }
  return {validate,preview,commit};
})();
