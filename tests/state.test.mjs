import { strict as assert } from 'node:assert';
import { mergeStates, resetToggles, clearItems, applyPromptCombination } from '../core.mjs';
const p={kind:'prompt',source:'P',id:'a',name:'A',state:false};
const w={kind:'world',source:'Book',id:'1',name:'W',state:false,activation:'vectorized'};
const shared={version:1,items:[p,w]}, local={version:1,items:[{...w,state:true,activation:null}]};
const snapshot=JSON.stringify(shared);
let effective=mergeStates(shared,local);
assert.equal(effective.items.find(x=>x.kind==='world').state,true);
assert.equal(effective.items.find(x=>x.kind==='world').activation,'vectorized');
resetToggles(local,'world');
assert.equal(local.items.length,1);
assert.equal(mergeStates(shared,local).items.find(x=>x.kind==='world').state,false);
clearItems(local,'world');assert.equal(local.items.length,0);
assert.equal(mergeStates(shared,local).items.length,2);
local.items.push({...p,source:'Q'},w);
applyPromptCombination(local,{version:1,items:[{...p,state:true},{...p,source:'WRONG'}]},'P');
assert.equal(local.items.length,3);assert.ok(local.items.some(x=>x.source==='Q'));assert.ok(local.items.some(x=>x.kind==='world'));
assert.equal(local.items.find(x=>x.source==='P').state,true);
applyPromptCombination(local,{version:1,items:[p]},'P');assert.equal(local.items.length,3);
assert.equal(JSON.stringify(shared),snapshot);
console.log('PASS: shared/local precedence, reset, clear, combination replacement and source isolation');

const { catalogPrompts } = await import('../core.mjs');
const prompts = [
 {identifier:'core',name:'🔹🔹 CORE 🔹🔹',marker:true},
 {identifier:'cleaner',name:'! Macro Cleaner !',marker:true},
 {identifier:'main',name:'Main',content:'MAIN'},
 {identifier:'cards',name:'🔹 🔹 CARD & LORE 🔹 🔹',marker:true},
 {identifier:'worldInfoBefore',name:'World Info',marker:true},
 {identifier:'ordinary',name:'🔹 Toggleable 🔹',content:'NORMAL'},
 {identifier:'same-title',name:'🔹🔹 CORE 🔹🔹',marker:true},
 {identifier:'last',name:'Last',content:'LAST'},
];
const manager={activeCharacter:{},getPromptOrderForCharacter:()=>prompts.map(p=>({identifier:p.identifier,enabled:true})),
 getPromptById:id=>prompts.find(p=>p.identifier===id),isPromptToggleAllowed:p=>!p.marker||p.identifier==='worldInfoBefore'};
const original=JSON.stringify(prompts),catalog=catalogPrompts(manager,'P').filter(x=>!x.heading);
assert.equal(catalog.length,4);
assert.deepEqual(catalog[0].sections.map(x=>x.title),['🔹🔹 CORE 🔹🔹','! Macro Cleaner !']);
assert.equal(catalog[1].sectionId,'cards','toggleable native marker remains an ordinary item');
assert.equal(catalog[2].sectionId,'cards','diamond text alone does not make a toggleable prompt a heading');
assert.equal(catalog[3].sectionId,'same-title','same title with a different ID starts a new section');
assert.equal(JSON.stringify(prompts),original);
assert.equal(catalogPrompts(manager,'Q')[0].source,'Q');
console.log('PASS: heading inheritance, locked functional markers, toggleable markers, duplicate headings, source preservation');

const varied=[
 {identifier:'format',name:'FORMATTING',marker:true},
 {identifier:'triangle',name:'🔻1ST ON: ASTERISKS🔻',marker:true},
 {identifier:'real',name:'Without Asterisks',content:'No asterisks'},
 {identifier:'line',name:'────────────',marker:true},
 {identifier:'plain',name:'시점 설정',content:'  \n  '},
 {identifier:'pov',name:'3rd Person',content:'Third person'},
 {identifier:'worldInfoBefore',name:'World Info',marker:true},
 {identifier:'chatHistory',name:'Chat History',marker:true},
 {identifier:'nsfw',name:'Auxiliary',content:''},
 {identifier:'customSystem',name:'Empty system',system_prompt:true,content:''},
 {identifier:'macro',name:'A macro',content:'{{getvar::test}}'},
 {identifier:'decorated',name:'🔻Important🔻',content:'Actual instruction'},
];
const variantManager={...manager,getPromptOrderForCharacter:()=>varied.map(p=>({identifier:p.identifier,enabled:true})),getPromptById:id=>varied.find(p=>p.identifier===id),isPromptToggleAllowed:p=>!p.marker||['worldInfoBefore','chatHistory'].includes(p.identifier)};
const variant=catalogPrompts(variantManager,'P');
assert.deepEqual(variant.filter(x=>x.heading).map(x=>x.id),['format','triangle','line','plain']);
assert.deepEqual(variant.find(x=>x.id==='real').sections.map(x=>x.id),['format','triangle']);
assert.deepEqual(variant.find(x=>x.id==='pov').sections.map(x=>x.id),['line','plain']);
assert.ok(variant.filter(x=>!x.heading).some(x=>x.id==='chatHistory'));
assert.ok(variant.filter(x=>!x.heading).some(x=>x.id==='customSystem'));
console.log('PASS: arbitrary headings, consecutive labels, line separators, blank custom titles, protected built-ins and content prompts');
