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
const original=JSON.stringify(prompts),catalog=catalogPrompts(manager,'P');
assert.equal(catalog.length,4);
assert.equal(catalog[0].sectionTitle,'🔹🔹 CORE 🔹🔹');
assert.equal(catalog[1].sectionId,'cards','toggleable native marker remains an ordinary item');
assert.equal(catalog[2].sectionId,'cards','diamond text alone does not make a toggleable prompt a heading');
assert.equal(catalog[3].sectionId,'same-title','same title with a different ID starts a new section');
assert.equal(JSON.stringify(prompts),original);
assert.equal(catalogPrompts(manager,'Q')[0].source,'Q');
console.log('PASS: heading inheritance, locked functional markers, toggleable markers, duplicate headings, source preservation');
