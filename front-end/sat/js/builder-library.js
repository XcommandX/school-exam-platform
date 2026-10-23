'use strict';
window.SATBuilderLibrary = (() => {
  const state = {status: 'idle', sources: [], questions: [], errors: [], message: ''};
  const collectionIdentity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
  const packIdentity = value => typeof value === 'string' && /^sat:pack:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  const itemIdentity = value => typeof value === 'string' && /^sat:item:[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  const revision = value => Number.isSafeInteger(value) && value > 0;
  const sourceId = (packId, packRevision) => `pack:${encodeURIComponent(packId)}@${packRevision}`;
  const questionId = question => `${sourceId(question.packId, question.packRevision)}:${encodeURIComponent(question.itemId)}@${question.itemRevision}`;
  const sectionName = value => value === 'math' || value === 'Math' ? 'Math' : value === 'reading-writing' || value === 'Reading and Writing' ? 'Reading and Writing' : null;
  const referenceKey = reference => JSON.stringify([reference.packId, reference.packRevision, reference.itemId, reference.itemRevision]);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  let refreshing = null, hydrationQueue = Promise.resolve();

  async function request(url) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', signal: controller.signal});
      if (!response.ok) throw new Error('The question library could not be loaded.');
      return await response.json();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The question library took too long to respond. Please try again.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function normalize(response) {
    assert(response?.schemaVersion === 1 && Array.isArray(response.sources) && Array.isArray(response.questions), 'The question index format is not supported.');
    const sources = [], questions = [], sourceMap = new Map(), questionIds = new Set();
    for (const source of response.sources) {
      const pack = source?.packIdentity;
      assert(pack && packIdentity(pack.id) && revision(pack.revision) && source.id === sourceId(pack.id, pack.revision), 'The question index contains an invalid package identity.');
      assert(!sourceMap.has(source.id) && collectionIdentity(source.libraryCollectionId || source.collectionId), 'The question index contains a duplicated or invalid source.');
      const section = sectionName(source.section), responseType = source.responseType || pack.responseType;
      assert(section && ['single-choice', 'student-produced-response'].includes(responseType) && (section !== 'Reading and Writing' || responseType === 'single-choice'), 'The question index contains an unsupported source.');
      assert(Number.isSafeInteger(source.questionCount) && source.questionCount > 0 && typeof source.fileName === 'string' && typeof source.displayName === 'string', 'The question index source metadata is incomplete.');
      const normalized = {
        id: source.id, fileName: source.fileName, displayName: source.displayName, section,
        questionCount: source.questionCount, defaultDurationSeconds: section === 'Math' ? 2100 : 1920,
        responseType, packIdentity: {id: pack.id, revision: pack.revision, section: section === 'Math' ? 'math' : 'reading-writing', responseType},
        collectionId: source.libraryCollectionId || source.collectionId,
        libraryCollectionId: source.libraryCollectionId || source.collectionId, indexOnly: true
      };
      sources.push(normalized); sourceMap.set(normalized.id, normalized);
    }
    const counts = new Map();
    for (const question of response.questions) {
      assert(question && packIdentity(question.packId) && revision(question.packRevision) && itemIdentity(question.itemId) && revision(question.itemRevision) && question.id === questionId(question), 'The question index contains an invalid question identity.');
      const source = sourceMap.get(question.metadata?.sourceId), section = sectionName(question.section);
      assert(source && !questionIds.has(question.id) && source.id === sourceId(question.packId, question.packRevision) && question.libraryCollectionId === source.libraryCollectionId && section === source.section && question.responseType === source.responseType, 'The question index question does not match its source.');
      assert(typeof question.passage === 'string' && typeof question.prompt === 'string' && typeof question.questionType === 'string' && Array.isArray(question.options) && question.options.every(option => typeof option === 'string') && question.options.length === (question.responseType === 'single-choice' ? 4 : 0), 'The question index question text is incomplete.');
      assert(Number.isSafeInteger(question.metadata.sourceQuestionIndex) && question.metadata.sourceQuestionIndex >= 0, 'The question index question position is invalid.');
      const metadata = {
        sourceId: source.id, sourceFileName: source.fileName, sourceQuestionIndex: question.metadata.sourceQuestionIndex,
        libraryCollectionId: source.libraryCollectionId, itemId: question.itemId, itemRevision: question.itemRevision,
        packId: question.packId, packRevision: question.packRevision
      };
      for (const key of ['sourceModuleNumber', 'sourceQuestionNumber', 'sourceOrderIndex']) {
        if (Number.isSafeInteger(question.metadata[key]) && question.metadata[key] >= 0) metadata[key] = question.metadata[key];
      }
      // Whitelist index fields. Answers, assets and explanations belong to the
      // selected collection request, never the all-library selection index.
      const normalized = {
        id: question.id, passage: question.passage, prompt: question.prompt, options: [...question.options],
        questionType: question.questionType, originalQuestionType: question.questionType, section,
        responseType: question.responseType, packId: question.packId, packRevision: question.packRevision,
        itemId: question.itemId, itemRevision: question.itemRevision,
        libraryCollectionId: source.libraryCollectionId, metadata, indexOnly: true
      };
      if (question.packSource && typeof question.packSource.kind === 'string') {
        normalized.packSource = Object.fromEntries(['kind', 'url', 'sourceSetId', 'sourceQuestionId']
          .filter(key => typeof question.packSource[key] === 'string').map(key => [key, question.packSource[key]]));
      }
      questions.push(normalized); questionIds.add(normalized.id);
      counts.set(source.id, (counts.get(source.id) || 0) + 1);
    }
    for (const source of sources) assert(counts.get(source.id) === source.questionCount, 'The question index count does not match its source.');
    return {sources, questions};
  }

  function refresh() {
    if (refreshing) return refreshing;
    state.status = 'loading'; state.message = '';
    refreshing = (async () => {
      try {
        const response = await request('/api/sat-library/question-index'), indexed = normalize(response);
        Object.assign(state, indexed, {
          status: 'ready', message: response.available === false ? 'No question library is connected.' : '',
          errors: Array.isArray(response.errors) ? response.errors.map(error => ({
            collectionId: collectionIdentity(error?.collectionId) ? error.collectionId : null,
            error: typeof error?.error === 'string' ? error.error : 'A question collection is unavailable.'
          })) : []
        });
      } catch (error) {
        state.status = 'error'; state.message = error.message || 'The question index could not be loaded.';
      } finally { refreshing = null; }
      return state;
    })();
    return refreshing;
  }

  function combine(localSources = [], localQuestions = []) {
    const sources = new Map(state.sources.map(source => [source.id, source]));
    const questions = new Map(state.questions.map(question => [question.id, question]));
    for (const source of localSources) {
      if (!source || source.deleted) continue;
      const indexed = sources.get(source.id);
      sources.set(source.id, indexed ? {...indexed, ...source, libraryCollectionId: indexed.libraryCollectionId, indexOnly: false} : source);
    }
    for (const question of localQuestions) {
      if (!question || question.deleted) continue;
      const indexed = questions.get(question.id);
      questions.set(question.id, indexed ? {
        ...indexed, ...question, libraryCollectionId: indexed.libraryCollectionId, indexOnly: false,
        metadata: {...indexed.metadata, ...question.metadata, libraryCollectionId: indexed.libraryCollectionId}
      } : question);
    }
    return {sources: [...sources.values()], questions: [...questions.values()]};
  }

  function collectionFiles(collection) {
    const files = [];
    for (const pack of collection.packs) {
      assert(Array.isArray(pack.files), 'The selected question package file list is invalid.');
      for (const entry of pack.files) {
        assert(typeof entry.path === 'string' && entry.path && !entry.path.includes('\\') && !entry.path.startsWith('/') && !entry.path.split('/').some(part => !part || part === '.' || part === '..'), 'A selected question package path is invalid.');
        const bytes = typeof entry.text === 'string' ? entry.text : typeof entry.dataBase64 === 'string' ? Uint8Array.from(atob(entry.dataBase64), letter => letter.charCodeAt(0)) : null;
        assert(bytes !== null, 'A selected question package file has no content.');
        const file = new File([bytes], entry.path.split('/').pop(), {type: entry.mediaType || ''});
        Object.defineProperty(file, 'webkitRelativePath', {value: entry.path}); files.push(file);
      }
    }
    return files;
  }

  async function prepareCollection(collectionId) {
    const indexed = state.questions.filter(question => question.libraryCollectionId === collectionId);
    const indexedSources = state.sources.filter(source => source.libraryCollectionId === collectionId);
    const collection = await request(`/api/sat-library/collections/${encodeURIComponent(collectionId)}`);
    assert(collection?.collectionId === collectionId && Array.isArray(collection.packs) && collection.packs.length && collection.questionCount === indexed.length, 'The selected question collection changed. Reload the question library.');
    const previews = await SATPack.previewFiles(collectionFiles(collection), new Set());
    assert(Array.isArray(previews) && previews.length === collection.packs.length && previews.every(preview => Array.isArray(preview.errors) && !preview.errors.length), 'The selected question collection failed package validation.');
    assert(previews.length === indexedSources.length, 'The selected question collection has missing packages.');
    const available = new Map(), seenSources = new Set();
    for (const preview of previews) {
      const source = indexedSources.find(source => source.id === preview.sourceId), pack = preview.packIdentity;
      const declared = pack && collection.packs.find(candidate => candidate.id === pack.id && candidate.revision === pack.revision);
      assert(source && !seenSources.has(source.id) && preview.isSATPack === true && pack && preview.sourceId === sourceId(pack.id, pack.revision) && declared && preview.questions.length === source.questionCount && declared.questionCount === source.questionCount && source.section === preview.section && source.responseType === preview.responseType, 'The selected question package does not match the question index.');
      seenSources.add(source.id);
      for (const question of preview.questions) {
        const id = questionId(question);
        assert(!available.has(id) && question.packId === pack.id && question.packRevision === pack.revision && source.section === question.section && source.responseType === question.responseType, 'The selected question package contains a duplicated or invalid question.');
        available.set(id, question);
      }
    }
    assert(available.size === indexed.length && indexed.every(question => available.has(question.id)), 'The selected question collection is missing indexed questions.');
    const modules = collection.assessment?.modules || collection.modules;
    assert(Array.isArray(modules) && modules.length, 'The selected question collection is missing source modules.');
    const references = [];
    for (const module of modules) {
      assert(Array.isArray(module.items) && module.items.length === module.questionCount && revision(module.moduleNumber) && sectionName(module.section), 'The selected question collection has an invalid source module.');
      for (const reference of module.items) {
        const question = available.get(questionId(reference));
        assert(question && sectionName(module.section) === question.section, 'The selected question collection source reference does not match its package.');
        references.push(referenceKey(reference));
      }
    }
    assert(references.length === available.size && new Set(references).size === available.size, 'The selected question collection has duplicated or missing source references.');
    // Preflight every identity/hash before writing, preserving any previous
    // same-revision source and attempts if the server has conflicting content.
    const prior = new Map();
    for (const preview of previews) {
      const previous = await SATStorage.get('sources', preview.sourceId);
      const priorHash = previous?.accountSnapshot ? previous.originalContentHash : previous?.contentHash;
      assert(!priorHash || priorHash === preview.contentHash, 'This package revision already exists with different content. Increase its revision.');
      prior.set(preview.sourceId, previous);
    }
    return {collectionId, previews, prior};
  }

  async function hydrateSelected(ids) {
    assert(Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string' && id), 'Select at least one question.');
    const indexed = new Map(state.questions.map(question => [question.id, question])), collections = new Set();
    for (const id of ids) {
      const question = indexed.get(id);
      if (question) collections.add(question.libraryCollectionId);
    }
    // Sequential per selected collection: no full-library package prefetch,
    // automatic folder sync, active-collection mutation, or history archive.
    const prepared = [];
    for (const collectionId of collections) prepared.push(await prepareCollection(collectionId));
    // Validate every selected collection before importing the first source.
    for (const {collectionId, previews, prior} of prepared) {
      for (const preview of previews) {
        const previous = prior.get(preview.sourceId);
        if (!previous || previous.deleted || previous.accountSnapshot) {
          preview.collectionId = collectionId;
          await SATImporter.commit(preview);
        }
      }
    }
    const questions = await Promise.all(ids.map(id => SATStorage.get('questions', id)));
    assert(questions.every(question => question && !question.deleted && !question.indexOnly), 'One or more selected questions could not be loaded.');
    for (const question of questions) {
      const reference = indexed.get(question.id);
      if (reference) assert(questionId(question) === reference.id && question.metadata?.sourceId === reference.metadata.sourceId && question.section === reference.section && question.responseType === reference.responseType, 'A selected question does not match its indexed identity.');
    }
    return questions;
  }

  function hydrate(questionIds) {
    const ids = Array.isArray(questionIds) ? [...questionIds] : questionIds;
    const pending = hydrationQueue.then(() => hydrateSelected(ids));
    hydrationQueue = pending.catch(() => {});
    return pending;
  }

  return {state, refresh, combine, hydrate};
})();
