'use strict';
window.SATStorage = (() => {
  let dbPromise;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('SATPracticeDB', 2);
      request.onupgradeneeded = event => {
        const db = request.result;
        if(event.oldVersion<1){
        const sources = db.createObjectStore('sources', {keyPath: 'id'});
        sources.createIndex('contentHash', 'contentHash', {unique: true});
        const questions = db.createObjectStore('questions', {keyPath: 'id'});
        questions.createIndex('sourceId', 'metadata.sourceId');
        db.createObjectStore('attempts', {keyPath: 'id'});
        db.createObjectStore('wrongBook', {keyPath: 'questionId'});
        }
        if(!db.objectStoreNames.contains('settings'))db.createObjectStore('settings',{keyPath:'id'});
      };
      request.onsuccess = () => {request.result.onversionchange = () => request.result.close(); resolve(request.result);};
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other SAT Practice tabs and reload to update the database.'));
    });
    return dbPromise;
  }
  async function read(store, method, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const request = tx.objectStore(store)[method](key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function write(stores, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('The database update could not be saved.'));
      tx.onerror = () => {};
      try {work(tx);} catch (error) {tx.abort(); reject(error);}
    });
  }
  const all = store => read(store, 'getAll');
  const get = (store,id) => read(store,'get',id);
  async function migrateDefaults(defaultQuestions) {
    // Read and write inside one transaction, so two first-run tabs cannot duplicate the seed.
    await write(['sources','questions'], tx => {
      const qs=tx.objectStore('questions'), ss=tx.objectStore('sources');
      qs.count().onsuccess = event => {
        if(event.target.result) return;
        const id='default-questions-v1', importedAt=Date.now();
        ss.put({id,fileName:'questions.js',displayName:'Default Questions',section:'Reading and Writing',importedAt,questionCount:defaultQuestions.length,defaultDurationSeconds:1920,contentHash:'builtin:questions-v1'});
        defaultQuestions.forEach((q,index)=>qs.put({id:`${id}:${index}`,passage:q.passage||'',prompt:q.prompt,options:[...q.options],correctOption:q.answer,questionType:q.questionType||'',explanation:q.explanation||'',aiExplanation:q.aiExplanation||'',metadata:{sourceId:id,sourceFileName:'questions.js',sourceQuestionIndex:index,importedAt}}));
      };
    });
  }
  const setSetting=(id,value)=>write(['settings'],tx=>tx.objectStore('settings').put({id,value}));
  async function migrateModel(){
    await write(['sources','questions','attempts'],tx=>{
      for(const name of ['sources','questions','attempts']){
        const store=tx.objectStore(name);store.openCursor().onsuccess=e=>{
          const cursor=e.target.result;if(!cursor)return;const row=cursor.value;
          if(name==='sources'){row.defaultDurationSeconds=SATModel.durationSeconds({durationSeconds:row.defaultDurationSeconds,durationMinutes:row.defaultDurationMinutes});delete row.defaultDurationMinutes;}
          if(name==='questions'){if(row.questionType&&!SATModel.category(row.questionType)){row.metadata={...row.metadata,originalQuestionType:row.metadata?.originalQuestionType||row.questionType};row.questionType='';}row.visualStimulus??=null;}
          if(name==='attempts'){SATModel.normalizePractice(row);if(row.runtimeSnapshot?.activePractice)SATModel.normalizePractice(row.runtimeSnapshot.activePractice);}
          cursor.update(row);cursor.continue();
        };
      }
    });
  }
  async function importSet(source, questions) {
    await write(['sources','questions'],tx=>{
      tx.objectStore('sources').add(source);
      questions.forEach(q=>tx.objectStore('questions').add(q));
    });
  }
  async function saveAttempt(attempt) {
    // Attempt and automatic wrong-book updates either all commit or all roll back.
    await write(['attempts','wrongBook'],tx=>{
      const attempts=tx.objectStore('attempts'), wrong=tx.objectStore('wrongBook');
      attempts.get(attempt.id).onsuccess=event=>{
        if(event.target.result?.status==='completed') return; // Completed settlement is idempotent.
        attempts.put(attempt);
        if(attempt.status!=='completed')return;
        Object.entries(attempt.answers).forEach(([questionId,answer])=>{
          if(answer.selectedOption===null || answer.selectedOption===answer.correctOption) return;
          wrong.get(questionId).onsuccess=e=>{if(!e.target.result) wrong.add({questionId,addedAt:attempt.completedAt,reason:'incorrect',sourceAttemptId:attempt.id});};
        });
      };
    });
  }
  async function addToWrongBook(record) {
    await write(['wrongBook'],tx=>{const store=tx.objectStore('wrongBook');store.get(record.questionId).onsuccess=e=>{if(!e.target.result)store.add(record);};});
  }
  const removeFromWrongBook=id=>write(['wrongBook'],tx=>tx.objectStore('wrongBook').delete(id));
  const deleteAttempt=id=>write(['attempts'],tx=>tx.objectStore('attempts').delete(id));
  async function removeLibrary(kind,id){
    let blocked;
    try{await write(['attempts','questions','sources'],tx=>{
      const qs=tx.objectStore('questions'),ss=tx.objectStore('sources');
      tx.objectStore('attempts').getAll().onsuccess=e=>{
        const pending=e.target.result.filter(a=>a.status==='incomplete'&&a.resumable);
        qs.getAll().onsuccess=event=>{
          const targets=event.target.result.filter(q=>kind==='source'?q.metadata.sourceId===id:q.id===id);
          if(pending.some(a=>targets.some(q=>a.questionIds.includes(q.id)))){
            blocked=new Error(kind==='source'?'Cannot delete this source while it is used by an unfinished practice.':'Cannot delete this question while it is used by an unfinished practice.');tx.abort();return;
          }
          const deletedAt=Date.now();targets.forEach(q=>qs.put({...q,deleted:true,deletedAt}));
          if(kind==='source')ss.get(id).onsuccess=x=>{if(x.target.result)ss.put({...x.target.result,deleted:true,deletedAt});};
        };
      };
    });}catch(error){throw blocked||error;}
  }
  return {setSetting,migrateModel,deleteAttempt,deleteQuestion:id=>removeLibrary('question',id),deleteSource:id=>removeLibrary('source',id),open,all,get,migrateDefaults,importSet,saveAttempt,addToWrongBook,removeFromWrongBook};
})();
