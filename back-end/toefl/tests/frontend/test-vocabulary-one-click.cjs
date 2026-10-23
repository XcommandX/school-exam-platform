const toeflFrontendRoot = require('node:path').resolve(__dirname, '../../../../front-end/toefl');
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const src=fs.readFileSync(toeflFrontendRoot+'/four-app.js','utf8');
function take(name){let a=src.indexOf('function '+name+'('),b=src.indexOf('\nfunction ',a+1);return src.slice(a,b)}
let output='',writes=[];
const words=[{word:'child',forms:['children'],meanings:['孩子'],kinds:['fill'],sources:[]},{word:'clear',forms:[],meanings:['清楚的'],kinds:['fill'],sources:[]}];
const c={s:{view:'vocab',vsource:'all',vstatus:'unmastered',vsort:'alphabet',vquery:'',vindex:0,flipped:false},recordVocabularyProgress:()=>null,wordState:{children:{note:'existing note'}},vocabularyUndo:null,words,navigationEpoch:0,pageEntry:null,searchTimer:null,timer:null,
 clearTimeout(){},clearInterval(){},suspendSession(){},haltFlow(){},esc:x=>String(x??''),shell:h=>output=h,vocabularyWords:()=>words,
 wordExamples:()=>[],vocabularyExamples:()=>'',vocabularyForms:()=>'',vocabularyFrequency:()=>'',vocabularyFamily:()=>'',save:(key,value)=>writes.push({key,value:JSON.parse(JSON.stringify(value))})};
vm.createContext(c);
for(const name of ['wordMastered','wordProgress','setWordProgress','vocabPool','renderVocab','markVocabulary','undoVocabulary'])vm.runInContext(take(name),c);
c.renderVocab();
let actions=output.match(/<div class="row vocab-actions">(.*?)<\/div>/s)[1];
assert(actions.includes('data-a="flip"'),'unfamiliar words can still reveal the definition');
assert(actions.includes('data-a="word-known"'),'known words can be marked before revealing');
assert(!output.includes('<div class="meaning">'),'definition remains hidden until requested');
c.markVocabulary(true);
assert.equal(c.wordState.child.mastered,true);assert.equal(c.wordState.children.mastered,true);
assert.equal(c.wordState.children.note,'existing note');
assert.equal(c.vocabPool()[c.s.vindex].word,'clear');assert.equal(c.s.flipped,false);
assert.equal(writes.length,1);assert.equal(writes[0].key,'four.words.v1','one-click progress uses the existing synchronized storage');
c.undoVocabulary();assert.equal(c.vocabPool()[c.s.vindex].word,'child');assert.equal(c.s.flipped,false);assert.equal(c.wordState.child,undefined);assert.equal(c.wordState.children.note,'existing note');
c.s.flipped=true;c.renderVocab();actions=output.match(/<div class="row vocab-actions">(.*?)<\/div>/s)[1];
assert(actions.includes('data-a="word-unknown"'));assert(actions.includes('data-a="word-known"'));assert(output.includes('<div class="meaning">'));
c.s.flipped=false;c.markVocabulary(true);c.markVocabulary(true);
assert.equal(c.s.vfinished,true);assert(output.includes('本轮词汇已完成'));assert(!output.includes('class="row vocab-actions"'));
console.log('PASS: hidden-definition one-click mastery, next word, grouped-form sync and notes, undo, definition review actions, final-card completion.');
