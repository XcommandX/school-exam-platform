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
          if(name==='questions'){if(!row.packContent&&row.questionType&&!SATModel.category(row.questionType)){row.metadata={...row.metadata,originalQuestionType:row.metadata?.originalQuestionType||row.questionType};row.questionType='';}row.visualStimulus??=null;}
          if(name==='attempts'){SATModel.normalizePractice(row);if(row.runtimeSnapshot?.activePractice)SATModel.normalizePractice(row.runtimeSnapshot.activePractice);}
          cursor.update(row);cursor.continue();
        };
      }
    });
  }
  async function importSet(source, questions) {
    let conflict;
    try{await write(['sources','questions'],tx=>{
      const sources=tx.objectStore('sources'),store=tx.objectStore('questions');
      sources.get(source.id).onsuccess=event=>{
        const previous=event.target.result;
        // Revisiting an archived collection reactivates the identical revision;
        // a changed package must declare a new revision to preserve old reviews.
        if(previous?.deleted&&source.packIdentity){
          if(previous.contentHash!==source.contentHash){conflict=new Error('This package revision already exists with different content. Increase its revision.');tx.abort();return;}
          sources.put({...previous,deleted:false,deletedAt:null,archivedForCollectionId:null,collectionId:source.collectionId||null});
          store.getAll().onsuccess=e=>e.target.result.filter(q=>q.metadata.sourceId===source.id&&(!previous.archivedForCollectionId||q.archivedForCollectionId)).forEach(q=>store.put({...q,deleted:false,deletedAt:null,archivedForCollectionId:null}));
          return;
        }
        sources.add(source);questions.forEach(q=>store.add(q));
      };
    });}catch(error){throw conflict||error;}
  }
  let archivePromise=null;
  async function archiveLibraryForCollection(collectionId, backup) {
    if(archivePromise)return archivePromise;
    const work=async()=>{
      if(typeof collectionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(collectionId))throw new Error('Invalid SAT collection identity.');
      const marker=(await get('settings','activeSATPackCollection'))?.value;
      if(marker?.collectionId===collectionId)return {changed:false,collectionId};
      const db=await open(),names=['sources','questions','attempts','wrongBook'];
      const snapshot=await new Promise((resolve,reject)=>{
        const tx=db.transaction(names,'readonly'),rows={};
        for(const name of names){const request=tx.objectStore(name).getAll();request.onsuccess=()=>{rows[name]=request.result;};}
        tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error||new Error('Could not read the current library for backup.'));tx.onerror=()=>{};
      });
      // The unified-platform bridge exposes its own key. Never look up the
      // original SAT application's database or localStorage namespace here.
      const runtimeKey=window.SATPlatformBridge?.runtimeKey||'sat-reading-practice-v1';
      const runtimeText=localStorage.getItem(runtimeKey);
      let runtimeSnapshot=null;
      if(runtimeText){try{runtimeSnapshot=JSON.parse(runtimeText);}catch{runtimeSnapshot={rawText:runtimeText};}}
      Object.assign(snapshot,{schemaVersion:'sat-library-backup/1',targetCollectionId:collectionId,previousCollectionId:marker?.collectionId||null,capturedAt:Date.now(),runtimeSnapshot});
      const saved=await backup(snapshot);
      if(!saved||saved.saved!==true)throw new Error('The browser library backup was not confirmed. Existing questions were kept.');
      if(localStorage.getItem(runtimeKey)!==runtimeText)throw new Error('The active practice changed during backup. Retry before changing collections.');
      const archivedAt=Date.now();let changed=true;
      await write(['sources','questions','attempts','settings'],tx=>{
        const settings=tx.objectStore('settings');
        settings.get('activeSATPackCollection').onsuccess=event=>{
          if(event.target.result?.value?.collectionId===collectionId){changed=false;return;}
          for(const name of ['sources','questions']){
            const store=tx.objectStore(name);store.getAll().onsuccess=e=>e.target.result.filter(row=>!row.deleted).forEach(row=>store.put({...row,deleted:true,deletedAt:archivedAt,archivedForCollectionId:collectionId}));
          }
          const attempts=tx.objectStore('attempts');attempts.getAll().onsuccess=e=>e.target.result.filter(row=>row.status==='incomplete'&&row.resumable).forEach(row=>attempts.put({...row,resumable:false,archivedForCollectionId:collectionId}));
          settings.put({id:'activeSATPackCollection',value:{collectionId,archivedAt,backup:{name:saved.name||null,sha256:saved.sha256||null}}});
        };
      });
      if(changed&&localStorage.getItem(runtimeKey)===runtimeText)localStorage.removeItem(runtimeKey);
      return {changed,collectionId,backup:saved};
    };
    archivePromise=work().finally(()=>{archivePromise=null;});return archivePromise;
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
          if(answer.correctness!==false) return;
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
  return {setSetting,migrateModel,archiveLibraryForCollection,deleteAttempt,deleteQuestion:id=>removeLibrary('question',id),deleteSource:id=>removeLibrary('source',id),open,all,get,migrateDefaults,importSet,saveAttempt,addToWrongBook,removeFromWrongBook};
})();
