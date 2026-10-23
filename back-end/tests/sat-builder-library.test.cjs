'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const {File} = require('node:buffer');

// Every question, package and image is created in memory. No local bank,
// catalog, conversion report, student record or real question file is read.
const javascript = name => fs.readFileSync(path.join(__dirname, '../../front-end/sat/js', name), 'utf8');
const makeSourceId = pack => `pack:${encodeURIComponent(pack.id)}@${pack.revision}`;
const makeQuestionId = (pack, item) => `${makeSourceId(pack)}:${encodeURIComponent(item.id)}@${item.revision}`;
const text = value => [{type: 'markdown', text: value}];

function fixture() {
  const sources = [], questions = [], collections = {};
  for (const [collectionId, definitions] of [
    ['original-rw', [['rw', 'reading-writing', 'single-choice', 2]]],
    ['original-math', [['math-choice', 'math', 'single-choice', 1], ['math-spr', 'math', 'student-produced-response', 1]]]
  ]) {
    const collection = {collectionId, title: collectionId, questionCount: 0, assessment: null, packs: [], modules: []};
    let number = 1;
    for (const [folder, section, responseType, count] of definitions) {
      const pack = {schemaVersion: 'sat-question-pack/0.1-draft', documentType: 'sat-question-pack', status: 'draft', exam: 'sat',
        id: `sat:pack:original-${folder}`, revision: 1, title: `Original ${folder}`, section, responseType,
        contentFormat: 'markdown-latex/0.1-draft', files: {items: 'items.json', solutions: 'solutions.json'}, assets: []};
      if (responseType === 'student-produced-response') pack.inputProfile = {id: 'sat-spr-input/0.1-draft', status: 'requires-rule-review', maxNonnegativeCharacters: 5, maxNegativeCharacters: 6, allowedForms: ['integer', 'decimal', 'fraction'], allowMixedNumber: false};
      const items = [], solutions = [], references = [];
      for (let index = 0; index < count; index++) {
        const item = {id: `sat:item:original-${folder}-${index}`, revision: 1, classification: {skill: 'Original skill'},
          content: text(`Original passage ${index}`), prompt: text(`Original question ${index}?`),
          source: {kind: 'original-synthetic', sourceSetId: collectionId, sourceQuestionId: String(number)}};
        if (responseType === 'single-choice') item.options = 'ABCD'.split('').map(label => ({id: `choice-${label.toLowerCase()}`, content: text(`Original ${label}`)}));
        items.push(item);
        solutions.push({itemId: item.id, itemRevision: 1, answer: {status: 'missing', type: responseType}, explanation: {status: 'missing', content: []}, provenance: {kind: 'original-synthetic'}});
        references.push({packId: pack.id, packRevision: pack.revision, itemId: item.id, itemRevision: item.revision});
        const sectionLabel = section === 'math' ? 'Math' : 'Reading and Writing';
        questions.push({id: makeQuestionId(pack, item), passage: `Original passage ${index}`, prompt: `Original question ${index}?`, options: item.options ? item.options.map(option => option.content[0].text) : [], questionType: item.classification.skill, section: sectionLabel, responseType,
          packId: pack.id, packRevision: 1, itemId: item.id, itemRevision: 1, libraryCollectionId: collectionId, packSource: item.source,
          metadata: {sourceId: makeSourceId(pack), sourceFileName: `${folder}/pack.json`, sourceQuestionIndex: index, sourceQuestionNumber: number++, sourceModuleNumber: 1, sourceOrderIndex: collection.questionCount + index}, indexOnly: true,
          correctOption: 'FORBIDDEN', answerRule: {secret: true}, packAssets: {secret: true}, explanation: 'FORBIDDEN'});
      }
      sources.push({id: makeSourceId(pack), fileName: `${folder}/pack.json`, displayName: pack.title, section: section === 'math' ? 'Math' : 'Reading and Writing', questionCount: count,
        defaultDurationSeconds: section === 'math' ? 2100 : 1920, responseType, packIdentity: {id: pack.id, revision: 1, section, responseType}, collectionId, libraryCollectionId: collectionId});
      const files = [['pack.json', pack], ['items.json', {items}], ['solutions.json', {visibility: 'authoring-only', solutions}]]
        .map(([name, document]) => ({path: `${folder}/${name}`, mediaType: 'application/json', text: JSON.stringify(document)}));
      collection.packs.push({id: pack.id, revision: 1, title: pack.title, section, responseType, questionCount: count, files});
      collection.questionCount += count;
      const module = collection.modules.find(module => module.section === section);
      if (module) { module.items.push(...references); module.questionCount += count; }
      else collection.modules.push({section, moduleNumber: 1, questionCount: count, items: references});
    }
    collections[collectionId] = collection;
  }
  return {index: {schemaVersion: 1, available: true, sources, questions, errors: []}, collections};
}

function harness(options = {}) {
  const data = fixture(), requests = [], sources = new Map(), questions = new Map(), forbidden = [], commits = [];
  const context = vm.createContext({AbortController, setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, File,
    crypto: webcrypto, atob, btoa, structuredClone, console,
    fetch: async (url, config) => {
      requests.push({url, config});
      if (options.fetch) return options.fetch(url, config);
      const body = url === '/api/sat-library/question-index' ? data.index : data.collections[decodeURIComponent(url.split('/').pop())];
      return {ok: !!body, json: async () => structuredClone(body)};
    }
  });
  context.window = context;
  context.SATStorage = {
    get: async (store, id) => structuredClone((store === 'sources' ? sources : questions).get(id)),
    importSet: async (source, imported) => {
      const previous = sources.get(source.id);
      if (previous && !previous.deleted) throw new Error('Duplicate source.');
      if (previous && previous.contentHash !== source.contentHash) throw new Error('Changed content.');
      sources.set(source.id, structuredClone(source));
      imported.forEach(question => questions.set(question.id, structuredClone(question)));
      commits.push(source.id);
    },
    archiveLibraryForCollection: async () => { forbidden.push('archive'); throw new Error('Forbidden archive.'); },
    setSetting: async () => { forbidden.push('setting'); throw new Error('Forbidden setting mutation.'); }
  };
  context.SATBank = {sync: async () => { forbidden.push('sync'); throw new Error('Forbidden sync.'); }};
  for (const file of ['sat-pack.js', 'importer.js', 'builder-library.js']) vm.runInContext(javascript(file), context, {filename: file});
  return {library: context.SATBuilderLibrary, data, requests, sources, questions, commits, forbidden, context};
}

(async () => {
  const h = harness(), {library} = h;
  assert.equal(library.state.status, 'idle');
  assert.equal(h.requests.length, 0, 'loading the module does not prefetch the library');
  const first = library.refresh(), second = library.refresh();
  assert.equal(first, second, 'concurrent refreshes share one pending request');
  await first;
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, '/api/sat-library/question-index');
  assert.equal(library.state.status, 'ready');
  assert.equal(library.state.sources.length, 3);
  assert.equal(library.state.questions.length, 4);
  assert.equal(JSON.stringify(library.state).includes('FORBIDDEN'), false, 'index state whitelists question fields');
  assert.equal(library.state.questions[0].packAssets, undefined);
  assert.equal(library.state.questions[0].answerRule, undefined);
  assert.equal(library.state.questions[0].packSource.kind, 'original-synthetic');
  assert.equal(library.state.questions[0].metadata.sourceQuestionNumber, 1);
  assert.ok(library.state.questions.every(question => question.indexOnly));

  const indexed = library.state.questions[0], indexedSource = library.state.sources[0];
  const complete = {...structuredClone(indexed), packContent: {prompt: text('Locally hydrated original')}, packAssets: {diagram: {src: 'data:image/png;base64,original'}}, indexOnly: undefined};
  const custom = {id: 'custom-original:0', prompt: 'Original personal fixture', metadata: {sourceId: 'custom-original'}};
  const combined = library.combine([{...structuredClone(indexedSource), contentHash: 'stored'} , {id: 'custom-original', displayName: 'Custom original'}], [complete, custom]);
  assert.equal(combined.questions.length, 5, 'same-ID imports count once while local custom questions remain');
  assert.equal(combined.sources.length, 4);
  assert.equal(combined.questions.find(question => question.id === indexed.id).indexOnly, false);
  assert.equal(combined.questions.find(question => question.id === indexed.id).packAssets.diagram.src, complete.packAssets.diagram.src, 'rich locally imported content wins over plain-text index');
  assert.equal(combined.questions.find(question => question.id === indexed.id).libraryCollectionId, 'original-rw');
  assert.equal(library.combine([], [{...custom, deleted: true}]).questions.length, 4);
  assert.equal(h.requests.length, 1, 'combining metadata never loads packages');

  const selected = [library.state.questions[1].id, indexed.id];
  const loaded = await library.hydrate(selected);
  assert.deepEqual(Array.from(loaded, question => question.id), selected, 'selected order is preserved');
  assert.ok(loaded.every(question => question.packContent && !question.indexOnly));
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].url, '/api/sat-library/collections/original-rw');
  assert.equal(h.commits.length, 1);
  assert.equal(h.sources.size, 1, 'unselected math sources are not imported');
  assert.equal(h.questions.size, 2);
  assert.equal(h.sources.values().next().value.collectionId, 'original-rw');
  await Promise.all([library.hydrate([indexed.id]), library.hydrate([indexed.id])]);
  assert.equal(h.commits.length, 1, 'same identity and content skip import even with concurrent starts');
  assert.equal(h.forbidden.length, 0, 'hydration cannot archive history, sync a folder or change settings');
  const imported = library.combine([...h.sources.values()], [...h.questions.values()]);
  assert.equal(imported.questions.length, 4, 'hydrated index questions are not double-counted');

  h.questions.set(custom.id, custom);
  const beforeLocal = h.requests.length;
  assert.equal((await library.hydrate([custom.id]))[0].id, custom.id);
  assert.equal(h.requests.length, beforeLocal, 'old local custom questions do not request any collection');
  await assert.rejects(library.hydrate(['missing-local']), /could not be loaded/);
  const mathIds = library.state.questions.filter(question => question.section === 'Math').map(question => question.id);
  const mathLoaded = await library.hydrate(mathIds);
  assert.equal(mathLoaded.length, 2);
  assert.ok(mathLoaded.some(question => question.responseType === 'student-produced-response' && question.options.length === 0));
  assert.equal(h.requests.at(-1).url, '/api/sat-library/collections/original-math');
  assert.equal(h.sources.size, 3);

  const archived = harness(); await archived.library.refresh();
  const archivedId = archived.library.state.questions[0].id;
  await archived.library.hydrate([archivedId]);
  const archivedSource = archived.sources.values().next().value;
  archived.sources.set(archivedSource.id, {...archivedSource, deleted: true});
  for (const [id, question] of archived.questions) archived.questions.set(id, {...question, deleted: true});
  await archived.library.hydrate([archivedId]);
  assert.equal(archived.commits.length, 2, 'explicit selection restores an archived identical source');
  assert.ok(!archived.questions.get(archivedId).deleted);
  assert.equal(archived.forbidden.length, 0);

  const allBeforeWrite = harness(); await allBeforeWrite.library.refresh();
  allBeforeWrite.data.collections['original-math'].modules[0].items[0].itemRevision++;
  const crossCollection = [allBeforeWrite.library.state.questions[0].id, allBeforeWrite.library.state.questions.at(-1).id];
  await assert.rejects(allBeforeWrite.library.hydrate(crossCollection), /reference does not match/);
  assert.equal(allBeforeWrite.commits.length, 0, 'every selected collection validates before the first import');
  assert.equal(allBeforeWrite.questions.size, 0);

  const altered = h.data.collections['original-rw'].packs[0].files.find(file => file.path.endsWith('/items.json'));
  const alteredItems = JSON.parse(altered.text);
  alteredItems.items[0].prompt = text('Changed original content with unchanged revision');
  altered.text = JSON.stringify(alteredItems);
  const commitsBeforeConflict = h.commits.length;
  await assert.rejects(library.hydrate([indexed.id]), /different content/);
  assert.equal(h.commits.length, commitsBeforeConflict, 'conflicting same-revision content never overwrites a saved source');

  for (const [label, mutate, pattern] of [
    ['collection count', collection => collection.questionCount++, /collection changed/],
    ['reference revision', collection => collection.modules[0].items[0].itemRevision++, /reference does not match/],
    ['duplicate reference', collection => collection.modules[0].items[1] = collection.modules[0].items[0], /duplicated or missing/],
    ['package count', collection => collection.packs[0].questionCount++, /does not match/],
    ['package identity', collection => collection.packs[0].id += '-wrong', /does not match/],
    ['unsafe path', collection => collection.packs[0].files[0].path = '../pack.json', /path is invalid/],
    ['missing file', collection => collection.packs[0].files.pop(), /package validation/]
  ]) {
    const malformed = harness(); await malformed.library.refresh();
    mutate(malformed.data.collections['original-rw']);
    await assert.rejects(malformed.library.hydrate([malformed.library.state.questions[0].id]), pattern, label);
    assert.equal(malformed.commits.length, 0, `${label} fails before any import`);
  }

  const invalidIndex = harness(); invalidIndex.data.index.questions[0].id = 'wrong';
  await invalidIndex.library.refresh();
  assert.equal(invalidIndex.library.state.status, 'error');
  assert.equal(invalidIndex.library.state.questions.length, 0);
  const badCount = harness(); badCount.data.index.sources[0].questionCount++;
  await badCount.library.refresh(); assert.equal(badCount.library.state.status, 'error');
  const empty = harness(); Object.assign(empty.data.index, {available: false, sources: [], questions: []});
  await empty.library.refresh();
  assert.equal(empty.library.state.status, 'ready');
  assert.match(empty.library.state.message, /No question library/);
  const offline = harness({fetch: async () => { throw new Error('Synthetic offline failure.'); }});
  await offline.library.refresh(); assert.equal(offline.library.state.status, 'error');
  assert.match(offline.library.state.message, /Synthetic offline failure/);
  const timeout = harness({fetch: async (_url, config) => new Promise((_resolve, reject) => {
    config.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), {name: 'AbortError'})));
  })});
  timeout.context.setTimeout = callback => { queueMicrotask(callback); return 1; };
  timeout.context.clearTimeout = () => {};
  await timeout.library.refresh(); assert.equal(timeout.library.state.status, 'error');
  assert.match(timeout.library.state.message, /took too long/);
  console.log('SAT builder index, lazy selected-collection hydration, identity protection and error checks passed (original synthetic fixtures only).');
})().catch(error => { console.error(error); process.exitCode = 1; });
