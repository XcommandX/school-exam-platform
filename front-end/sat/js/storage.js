'use strict';
window.SATStorage = (() => {
  let dbPromise;
  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('SATPracticeDB', 3);
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
        if(!db.objectStoreNames.contains('accountSync'))db.createObjectStore('accountSync',{keyPath:'id'});
        if(!db.objectStoreNames.contains('accountSyncConflicts'))db.createObjectStore('accountSyncConflicts',{keyPath:'id'});
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
      tx.oncomplete = () => {resolve();if(tx.accountSyncChanged)window.dispatchEvent(new CustomEvent('sat-account-local-change'));};
      tx.onabort = () => reject(tx.error || new Error('The database update could not be saved.'));
      tx.onerror = () => {};
      try {work(tx);} catch (error) {tx.abort(); reject(error);}
    });
  }
  const syncSettings=new Set(['appConfig','practiceDurationPreferences','customPracticeDurationSeconds','timingTargets','questionTimer']);
  const accountSyncEnabled=()=>Boolean(window.PlatformSession?.user?.id&&window.SATAccountSync);
  const personalStores=names=>accountSyncEnabled()?[...new Set([...names,'accountSync','accountSyncConflicts'])]:names;
  function journal(tx,kind,entityId,value,deleted=false){
    if(!accountSyncEnabled()||kind==='settings'&&!syncSettings.has(entityId))return;
    const store=tx.objectStore('accountSync'),id=kind+':'+entityId;
    store.get(id).onsuccess=event=>{
      const previous=event.target.result||{id,kind,entityId,revision:0,deleted:false};
      const pending={mutationId:crypto.randomUUID(),revision:previous.revision||0,value:deleted?null:structuredClone(value),deleted,updatedAt:Date.now()};
      if(kind==='wrongBook'&&!deleted&&previous.deleted)pending.restore=true;
      if(kind==='settings')pending.baseValue=previous.pending?.baseValue??previous.baseline;
      store.put({...previous,pending});tx.accountSyncChanged=true;
    };
  }
  function storeWrong(tx,record,knownQuestion){
    const store=tx.objectStore('wrongBook');
    store.get(record.questionId).onsuccess=event=>{
      if(event.target.result)return;
      const save=question=>{
        const finish=source=>{
          if(question?.metadata?.sourceId&&!source){source={id:question.metadata.sourceId,fileName:question.metadata.sourceFileName||'Saved practice',displayName:question.metadata.sourceFileName||'Saved practice',importedAt:question.metadata.importedAt||Date.now(),contentHash:'account-snapshot:'+question.metadata.sourceId,questionCount:1,accountSnapshot:true};tx.objectStore('sources').put(source);}
          if(question){const questions=tx.objectStore('questions');questions.get(question.id).onsuccess=e=>{if(!e.target.result)questions.put({...structuredClone(question),accountSnapshot:true});};}
          const value={...record,...(question?{questionSnapshot:structuredClone(question)}:{}),...(source?{sourceSnapshot:structuredClone(source)}:{})};store.add(value);journal(tx,'wrongBook',record.questionId,value);
        };
        if(question?.metadata?.sourceId)tx.objectStore('sources').get(question.metadata.sourceId).onsuccess=e=>finish(e.target.result);
        else finish();
      };
      if(knownQuestion){save(knownQuestion);return;}
      tx.objectStore('questions').get(record.questionId).onsuccess=e=>{
        if(e.target.result){save(e.target.result);return;}
        const attempts=tx.objectStore('attempts');
        if(record.sourceAttemptId)attempts.get(record.sourceAttemptId).onsuccess=a=>save(a.target.result?.questionSnapshots?.find(q=>q.id===record.questionId));
        else attempts.getAll().onsuccess=a=>save(a.target.result.flatMap(row=>row.questionSnapshots||[]).find(q=>q.id===record.questionId));
      };
    };
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
  const setSetting=(id,value)=>write(personalStores(['settings']),tx=>{tx.objectStore('settings').put({id,value});journal(tx,'settings',id,value);});
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
        // A downloaded wrong-book snapshot contains only selected questions.
        // Loading the actual source must replace that placeholder and fill in
        // the remaining questions; attempt snapshots keep their own versions.
        if(previous?.accountSnapshot){if(source.packIdentity&&previous.originalContentHash&&previous.originalContentHash!==source.contentHash){conflict=new Error('This package revision already exists with different content. Increase its revision.');tx.abort();return;}sources.put({...source,accountSnapshot:false});questions.forEach(q=>store.put(q));return;}
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
    await write(personalStores(['attempts','wrongBook','questions','sources']),tx=>{
      const attempts=tx.objectStore('attempts'), wrong=tx.objectStore('wrongBook');
      attempts.get(attempt.id).onsuccess=event=>{
        if(event.target.result?.status==='completed') return; // Completed settlement is idempotent.
        attempts.put(attempt);journal(tx,'attempts',attempt.id,attempt);
        if(attempt.status!=='completed')return;
        Object.entries(attempt.answers).forEach(([questionId,answer])=>{
          if(answer.correctness!==false) return;
          storeWrong(tx,{questionId,addedAt:attempt.completedAt,reason:'incorrect',sourceAttemptId:attempt.id},attempt.questionSnapshots?.find(q=>q.id===questionId));
        });
      };
    });
  }
  async function addToWrongBook(record) {
    await write(personalStores(['wrongBook','questions','sources','attempts']),tx=>storeWrong(tx,record));
  }
  const removeFromWrongBook=id=>write(personalStores(['wrongBook']),tx=>{tx.objectStore('wrongBook').delete(id);journal(tx,'wrongBook',id,null,true);});
  const deleteAttempt=id=>write(personalStores(['attempts']),tx=>{tx.objectStore('attempts').delete(id);journal(tx,'attempts',id,null,true);});
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
