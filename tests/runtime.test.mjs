import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import * as core from '../core.mjs';
import * as floating from '../floating.mjs';
import * as scopes from '../scopes.mjs';
import * as activation from '../activation.mjs';

// In-memory DOM/event model. No browser, local server, network, or layout engine.
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attrs={};this.handlers={};this.style={setProperty:(k,v,p)=>{(this.style.values??={})[k]=v}};this.className='';this._text='';this.hidden=false;this.value='';this.scrollTop=0;this.classList={add:c=>{this.classList.toggle(c,true)},toggle:(c,on)=>{const s=new Set(this.className.split(' '));on?s.add(c):s.delete(c);this.className=[...s].join(' ')}};}
 set textContent(s){this._text=String(s);this.children=[];} get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
 append(...nodes){for(const n of nodes){this.children.push(n);n.parent=this;}}
 replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k]??null;}
 addEventListener(k,f){(this.handlers[k]??=[]).push(f);} removeEventListener(k,f){this.handlers[k]=(this.handlers[k]||[]).filter(x=>x!==f);}
 async fire(k){if(this.disabled)return;for(const f of [...this.handlers[k]||[]])await f({target:this});}
 querySelectorAll(s){if(s.includes(','))return [...new Set(s.split(',').flatMap(x=>this.querySelectorAll(x.trim())))];s=s.replace(/=([a-z-]+)\]/g,'="$1"]');const match=e=>{if(s.startsWith('.'))return e.className.split(' ').includes(s.slice(1));if(s.startsWith('#'))return e.id===s.slice(1);let m=s.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);if(m){let v=m[1].startsWith('data-')?e.dataset[m[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:e.attrs[m[1]];return m[2]===undefined?v!==undefined:v===m[2];}return e.tagName===s.toUpperCase()};return this.children.flatMap(e=>[...(match(e)?[e]:[]),...e.querySelectorAll(s)]);}
 querySelector(s){return this.querySelectorAll(s)[0]??null;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(x=>x!==this);}
 matches(selector){return selector===':popover-open' && !!this.popoverOpen;} showPopover(){this.popoverOpen=true;} hidePopover(){this.popoverOpen=false;}
 focus(){} showModal(){this.open=true;} close(){this.open=false;for(const f of this.handlers.close||[])f();}
}
const document={body:new Element('body'),readyState:'complete',createElement:tag=>new Element(tag),getElementById:id=>document.body.querySelector('#'+id),addEventListener(){},removeEventListener(){}};
const settings=new Element('div');settings.id='extensions_settings';document.body.append(settings);
const extensionSettings = {}; let settingsSaves=0;
let character='c.png',chat='A',preset='P',busy=false,saves=[],stops=0;const chats={A:{},B:{},C:{}};
const events={};const types=Object.fromEntries(['APP_READY','WORLDINFO_ENTRIES_LOADED','GENERATION_AFTER_COMMANDS','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','OAI_PRESET_CHANGED_AFTER','WORLDINFO_SETTINGS_UPDATED','WORLDINFO_UPDATED','WORLD_INFO_ACTIVATED','GENERATE_AFTER_DATA'].map(n=>[n,n]));
const eventSource={on:(n,f)=>(events[n]??=[]).push(f),removeListener:(n,f)=>{events[n]=(events[n]||[]).filter(x=>x!==f)},emit:async(n,...args)=>{for(const f of [...events[n]||[]])await f(...args)}};
const originalWorld=Object.freeze({world:'Book',uid:7,comment:'말투',key:['hello'],disable:false,content:'WORLD'});
let worldGate=null, worldCalls=0;
async function getSortedEntries(){worldCalls++;if(worldGate)await worldGate;const payload={globalLore:[{...originalWorld}],characterLore:[],chatLore:[],personaLore:[]};await eventSource.emit(types.WORLDINFO_ENTRIES_LOADED,payload);return payload.globalLore;}
const manager={activeCharacter:{id:100001},serviceSettings:{prompts:[{identifier:'main',name:'기본',content:'MAIN'},{identifier:'a',name:'문체',content:'STYLE'},{identifier:'b',name:'시점',content:'POV'}],prompt_order:[{character_id:100001,order:[{identifier:'main',enabled:true},{identifier:'a',enabled:true},{identifier:'b',enabled:false}]}]},preparePrompt:p=>structuredClone(p),isPromptToggleAllowed:()=>true};
Object.assign(manager, {
 getPromptOrderForCharacter(){return this.serviceSettings.prompt_order[0].order},
 getPromptById(id){return this.serviceSettings.prompts.find(x=>x.identifier===id)},
 isPromptDisabledForActiveCharacter(id){return !this.getPromptOrderForCharacter().find(x=>x.identifier===id).enabled},
 getPromptsForCharacter(c,only=false){return this.getPromptOrderForCharacter().filter(x=>!only||x.enabled).map(x=>this.getPromptById(x.identifier))},
 getPromptCollection(){return this.getPromptsForCharacter(this.activeCharacter,true)},
});
const originalSettings=JSON.stringify(manager.serviceSettings);
let timerId=0;const timers=new Map();const notices=[];
const c=vm.createContext({document,URL,console,structuredClone,crypto:webcrypto,setTimeout:f=>{timers.set(++timerId,f);return timerId},clearTimeout:id=>timers.delete(id),SillyTavern:{getContext:()=>({extensionSettings,saveSettingsDebounced:()=>{settingsSaves++;},mainApi:'openai',name2:'테스트',characterId:0,characters:[{avatar:character}],getCurrentChatId:()=>chat,getPresetManager:()=>({getSelectedPresetName:()=>preset}),chatMetadata:chats[chat],saveMetadata:async()=>{saves.push({chat,state:structuredClone(chats[chat])})}})},toastr:{info:m=>notices.push(m),error:m=>notices.push(m)}});
const synthetic=o=>new vm.SyntheticModule(Object.keys(o),function(){for(const [k,v]of Object.entries(o))this.setExport(k,v)},{context:c});
const modules={
 '../../../../script.js':synthetic({eventSource,event_types:types,isGenerating:()=>busy,stopGeneration:()=>{busy=false;stops++;eventSource.emit(types.GENERATION_STOPPED)}}),
 '../../../openai.js':synthetic({promptManager:manager}),'../../../world-info.js':synthetic({getSortedEntries}),'./core.mjs':synthetic(core),'./floating.mjs':synthetic(floating),'./scopes.mjs':synthetic(scopes),'./activation.mjs':synthetic(activation),
};
const entry=new vm.SourceTextModule(readFileSync(new URL('../index.js',import.meta.url),'utf8')+'\nexport { refreshWorlds as testRefreshWorlds };',{context:c,identifier:new URL('../index.js',import.meta.url).href,initializeImportMeta:meta=>{meta.url=new URL('../index.js',import.meta.url).href}});
await entry.link(name=>modules[name]);await entry.evaluate();
const flush=async()=>{for(const [id,fn]of [...timers]){timers.delete(id);await fn();}await new Promise(r=>setImmediate(r));};
const find=(s)=>document.body.querySelector(s);
const button=t=>document.body.querySelectorAll('button').find(b=>b.textContent===t);
async function add(kind,index){await find(`[data-tab="${kind}"]`).fire('click');await button('＋ 추가').fire('click');const d=find('.csb-dialog');assert.ok(d);const boxes=d.querySelectorAll('input').filter(x=>x.type==='checkbox');boxes[index].checked=true;await boxes[index].fire('change');await button('1개 추가').fire('click');}

await find('.csb-launcher').fire('click'); await flush();
assert.deepEqual(document.body.querySelectorAll('[data-tab]').map(x=>x.dataset.tab),['active','prompt','world']);
assert.equal(find('[data-tab="active"]').getAttribute('aria-selected'),'true');
await add('prompt',1);
await find('[role="switch"]').fire('click');
assert.equal(manager.isPromptDisabledForActiveCharacter('a'),true);
chat='C';character='other.png';await eventSource.emit(types.CHAT_CHANGED);await flush();
assert.equal(find('[role="switch"]').textContent,'OFF');
assert.equal(manager.isPromptDisabledForActiveCharacter('a'),true);
preset='Q';await eventSource.emit(types.OAI_PRESET_CHANGED_AFTER);await flush();
assert.equal(find('[role="switch"]'),null);
preset='P';chat='A';character='c.png';await eventSource.emit(types.CHAT_CHANGED);await flush();
await find('[data-tab="world"]').fire('click');await flush();
await find('[data-tab="active"]').fire('click');
assert.equal(find('.csb-badge').hidden,true);
busy=true;await eventSource.emit(types.GENERATION_AFTER_COMMANDS,'normal',{},false);
await eventSource.emit(types.WORLD_INFO_ACTIVATED,[originalWorld]);await eventSource.emit(types.GENERATE_AFTER_DATA,{},false);await flush();
assert.equal(find('.csb-badge').textContent,'1');assert.equal(find('[role="switch"]').disabled,true);
busy=false;await eventSource.emit(types.GENERATION_ENDED);await flush();
assert.equal(find('.csb-item-copy'),null);
await find('[role="switch"]').fire('click');await flush();
assert.equal(find('[role="switch"]').textContent,'OFF');assert.equal(find('.csb-badge').textContent,'1');
await find('[data-tab="world"]').fire('click');
assert.equal(find('[role="switch"]').textContent,'OFF');
assert.equal((await getSortedEntries())[0].disable,true);
chat='B';await eventSource.emit(types.CHAT_CHANGED);await flush();
assert.equal(find('[role="switch"]').textContent,'ON');assert.equal(find('.csb-badge').hidden,true);
assert.equal((await getSortedEntries())[0].disable,false);
chat='C';character='other.png';await eventSource.emit(types.CHAT_CHANGED);await flush();assert.equal(find('[role="switch"]'),null);
chat='A';character='c.png';await eventSource.emit(types.CHAT_CHANGED);await flush();assert.equal(find('[role="switch"]').textContent,'OFF');
await find('[data-tab="active"]').fire('click');assert.equal(find('.csb-active-title'),null);
await eventSource.emit(types.GENERATION_AFTER_COMMANDS,'normal',{},false);await eventSource.emit(types.GENERATE_AFTER_DATA,{},false);await eventSource.emit(types.GENERATION_ENDED);await flush();
assert.equal(find('.csb-badge').textContent,'0');assert.equal(find('.csb-badge').hidden,false);
await eventSource.emit(types.GENERATION_AFTER_COMMANDS,'normal',{},false);await eventSource.emit(types.GENERATION_STOPPED);await flush();assert.equal(find('.csb-badge').hidden,true);
await eventSource.emit(types.GENERATION_AFTER_COMMANDS,'normal',{},true);await eventSource.emit(types.GENERATE_AFTER_DATA,{},true);await flush();assert.equal(find('.csb-badge').hidden,true);
await eventSource.emit(types.GENERATION_AFTER_COMMANDS,'quiet',{},false);await eventSource.emit(types.WORLD_INFO_ACTIVATED,[originalWorld]);await eventSource.emit(types.GENERATE_AFTER_DATA,{},false);await eventSource.emit(types.GENERATION_ENDED);await flush();assert.equal(find('.csb-badge').hidden,true);
await eventSource.emit(types.GENERATION_AFTER_COMMANDS,'swipe',{},false);await eventSource.emit(types.WORLD_INFO_ACTIVATED,[originalWorld]);await eventSource.emit(types.GENERATE_AFTER_DATA,{},false);await eventSource.emit(types.GENERATION_ENDED);await flush();assert.equal(find('.csb-badge').textContent,'1');
assert.equal(JSON.stringify(manager.serviceSettings),originalSettings,'native preset untouched');assert.equal(originalWorld.disable,false);
entry.namespace.onDisable();assert.equal(find('.csb-launcher'),null);assert.ok(Object.values(events).every(x=>x.length===0));
entry.namespace.onEnable();await flush();assert.equal(find('.csb-badge').hidden,true);assert.equal(document.body.querySelectorAll('.csb-launcher').length,1);
assert.deepEqual(notices,[]);
console.log('PASS: integrated DOM/event simulation: presets, character registries, chat overrides, auto-registration, badge, zero, failure, dry-run, quiet, swipe, original preservation and lifecycle');

await find('.csb-launcher').fire('click');await flush();
await find('[data-tab="world"]').fire('click');await find('[data-tab="world"]').fire('click');await flush();
await find('[data-action="reset"]').fire('click');assert.ok(button('확인'));await button('확인').fire('click');await flush();
assert.equal(find('[role="switch"]').textContent,'ON','toolbar reset restores native world state');
await find('[data-action="edit"]').fire('click');
assert.deepEqual(find('.csb-bulk').querySelectorAll('button').map(x=>x.textContent),['모두 삭제','구분선 추가']);
await button('구분선 추가').fire('click');await flush();
assert.equal(document.body.querySelectorAll('.csb-divider').length,1);
assert.equal(find('.csb-divider').querySelector('[role="switch"]'),null);
const stored=()=>scopes.readScopedState(extensionSettings[core.KEY],chats[chat],JSON.stringify(['character',character]),JSON.stringify(['openai',preset]));
assert.equal(stored().items.filter(x=>x.kind==='world').at(-1).separator,true);
await find('.csb-divider').querySelector('[data-row-action="up"]').fire('click');await flush();
assert.equal(stored().items.filter(x=>x.kind==='world')[0].separator,true,'separator moves above book entry');
await find('.csb-divider').querySelector('[data-row-action="down"]').fire('click');await flush();
assert.equal(stored().items.filter(x=>x.kind==='world').at(-1).separator,true);
await find('[data-action="edit"]').fire('click');assert.equal(find('.csb-divider').querySelector('button'),null,'line only outside organize mode');
chat='B';await eventSource.emit(types.CHAT_CHANGED);await flush();assert.ok(find('.csb-divider'),'character registry retains separator in another chat');
await find('[data-action="edit"]').fire('click');await button('모두 삭제').fire('click');await button('확인').fire('click');await flush();
assert.equal(stored().items.filter(x=>x.kind==='world').length,0);
assert.equal(originalWorld.disable,false,'clear never deletes native book');
await find('[data-tab="prompt"]').fire('click');await find('[data-action="edit"]').fire('click');
await button('구분선 추가').fire('click');await flush();assert.ok(find('.csb-divider'));
await find('[data-action="reset"]').fire('click');await button('확인').fire('click');await flush();
assert.equal(manager.isPromptDisabledForActiveCharacter('a'),false,'prompt reset restores original');
assert.ok(stored().items.some(x=>x.separator),'reset preserves separators');
assert.deepEqual(notices,[]);
console.log('PASS: toolbar reset, compact organize actions, separator add/move/persistence, no toggle, and clear');
