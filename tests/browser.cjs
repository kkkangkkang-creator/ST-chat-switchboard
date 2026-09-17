// Run with Playwright installed: node tests/browser.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const prefix = '/scripts/extensions/third-party/chat-switchboard/';
const mock = `
export const event_types=Object.fromEntries(['APP_READY','GENERATION_AFTER_COMMANDS','GENERATION_ENDED','GENERATION_STOPPED','CHAT_CHANGED','OAI_PRESET_CHANGED_AFTER','WORLDINFO_SETTINGS_UPDATED','WORLDINFO_UPDATED','WORLDINFO_ENTRIES_LOADED','WORLD_INFO_ACTIVATED','GENERATE_AFTER_DATA'].map(x=>[x,x]));
const listeners={};
export const eventSource={on:(n,f)=>(listeners[n]??=[]).push(f),removeListener:(n,f)=>{listeners[n]=(listeners[n]||[]).filter(x=>x!==f)},emit:async(n,...a)=>{for(const f of [...listeners[n]||[]])await f(...a)}};
export const isGenerating=()=>window.busy||false;
export const stopGeneration=()=>{window.busy=false;eventSource.emit('GENERATION_STOPPED')};
const chats={A:{},B:{},C:{}};const extensionSettings={};window.currentChat='A';window.character=0;window.preset='기본 서술';
export const pm={activeCharacter:{id:100001},prompts:[{identifier:'main',name:'기본 시스템',content:'MAIN'}, {identifier:'style',name:'자연스러운 대화',content:'STYLE'}],order:[{identifier:'main',enabled:true},{identifier:'style',enabled:true}],
getPromptOrderForCharacter(){return this.order},getPromptById(id){return this.prompts.find(x=>x.identifier===id)},isPromptDisabledForActiveCharacter(id){return !this.getPromptOrderForCharacter().find(x=>x.identifier===id).enabled},getPromptsForCharacter(c,only=false){return this.getPromptOrderForCharacter().filter(x=>!only||x.enabled).map(x=>this.getPromptById(x.identifier))},getPromptCollection(){return this.getPromptsForCharacter(this.activeCharacter,true)},isPromptToggleAllowed(){return true}};
window.books=[{world:'아르덴 · 캐릭터',uid:1,comment:'아르덴의 기본 설정',key:[],content:'LONG BODY',disable:false,constant:true},{world:'아르덴 · 캐릭터',uid:2,comment:'두 사람의 오래된 약속',key:['약속'],content:'BODY',disable:false},{world:'북부 도시 · 세계관',uid:3,comment:'도서관',key:['도서관'],content:'BODY',disable:false,vectorized:true}];
window.SillyTavern={getContext:()=>({extensionSettings,saveSettingsDebounced:async()=>{},chatMetadata:chats[window.currentChat],getCurrentChatId:()=>window.currentChat,characterId:window.character,characters:[{avatar:'arden.png'},{avatar:'other.png'}],name2:'아르덴',mainApi:'openai',getPresetManager:()=>({getSelectedPresetName:()=>window.preset}),saveMetadata:async()=>{}})};
window.switchChat=async(id,character=0)=>{window.currentChat=id;window.character=character;await eventSource.emit('CHAT_CHANGED')};
window.switchPreset=async name=>{window.preset=name;await eventSource.emit('OAI_PRESET_CHANGED_AFTER')};
window.events=eventSource;window.pm=pm;window.extensionSettings=extensionSettings;window.chats=chats;
window.toastr={info:m=>console.log(m),error:m=>{throw new Error(m)}};
`;
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://st.test/**',async route=>{
  const p=new URL(route.request().url()).pathname;let body,contentType='text/javascript';
  if(p==='/'){contentType='text/html';body=`<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${prefix}style.css"><style>body{background:#edeae4;font-family:Arial,sans-serif}h1{font-size:16px;color:#777;margin:28px 15px}</style><body><h1>아르덴 · 채팅</h1><div id="extensions_settings"></div><script type="module" src="${prefix}index.js"></script></body></html>`}
  else if(p==='/script.js')body=mock;
  else if(p==='/scripts/openai.js')body="export {pm as promptManager} from '../script.js'";
  else if(p==='/scripts/world-info.js')body="import {eventSource} from '../script.js';export async function getSortedEntries(){const payload={globalLore:structuredClone(window.books),characterLore:[],chatLore:[],personaLore:[]};await eventSource.emit('WORLDINFO_ENTRIES_LOADED',payload);window.lastWorld=payload;return payload.globalLore}";
  else if(p.startsWith(prefix)){const file=path.join(root,p.slice(prefix.length));if(!fs.existsSync(file))return route.fulfill({status:404,body:''});body=fs.readFileSync(file);contentType=p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'text/javascript'}
  else return route.fulfill({status:404,body:''});
  return route.fulfill({status:200,contentType,body});
 });
 await page.goto('http://st.test/');
 await page.locator('.csb-launcher').click();
 assert.equal(await page.locator('.csb-badge').isVisible(),false);
 await page.locator('[data-tab=prompt]').click();
 // Register and toggle a prompt, then use it in another character/chat.
 await page.locator('[data-action=add]').click();
 await page.locator('.csb-choice input').first().check();
 await page.getByRole('button',{name:'1개 추가',exact:true}).click();
 await page.locator('.csb-switch').click();
 assert.equal(await page.locator('.csb-switch').innerText(),'OFF');
 await page.evaluate(()=>window.switchChat('C',1));
 await page.waitForTimeout(160);
 assert.equal(await page.locator('.csb-switch').innerText(),'OFF');
 assert.equal(await page.evaluate(()=>window.pm.isPromptDisabledForActiveCharacter('main')),true);
 await page.evaluate(()=>window.switchPreset('다른 프리셋'));
 await page.waitForTimeout(160);
 assert.equal(await page.locator('.csb-switch').count(),0);
 await page.evaluate(async()=>{await window.switchPreset('기본 서술');await window.switchChat('A')});
 await page.locator('[data-tab=world]').click();
 await page.locator('[data-tab=active]').click();
 await page.evaluate(async()=>{window.busy=true;await events.emit('GENERATION_AFTER_COMMANDS','normal',{},false);await events.emit('WORLD_INFO_ACTIVATED',books);await events.emit('GENERATE_AFTER_DATA',{},false);window.busy=false;await events.emit('GENERATION_ENDED')});
 await page.waitForTimeout(160);
 assert.equal(await page.locator('.csb-badge').innerText(),'3');
 assert.equal(await page.locator('.csb-active-title').count(),3);
 assert.equal(await page.locator('.csb-item-copy').count(),0,'no active detail button');
 await page.locator('.csb-switch').first().click();
 assert.equal(await page.locator('.csb-switch').first().innerText(),'OFF');
 assert.equal(await page.locator('.csb-badge').innerText(),'3','toggle does not rewrite generation count');
 await page.locator('[data-tab=world]').click();
 assert.equal(await page.locator('.csb-switch').count(),1,'toggle auto-registers');
 assert.equal(await page.locator('.csb-switch').innerText(),'OFF');
 await page.evaluate(()=>window.switchChat('B'));
 await page.waitForTimeout(180);
 assert.equal(await page.locator('.csb-switch').innerText(),'ON','new chat uses native state');
 assert.equal(await page.locator('.csb-badge').isVisible(),false);
 await page.evaluate(()=>window.switchChat('C',1));
 await page.waitForTimeout(180);
 assert.equal(await page.locator('.csb-switch').count(),0,'different character has different WI list');
 await page.evaluate(()=>window.switchChat('A'));
 await page.waitForTimeout(180);
 assert.equal(await page.locator('.csb-switch').innerText(),'OFF');
 await page.locator('[data-tab=active]').click();
 assert.equal(await page.locator('.csb-active-title').count(),0,'returning chat has no cached activation');
 // Successful zero, then early failure, then dry-run/quiet must not invent a result.
 await page.evaluate(async()=>{await events.emit('GENERATION_AFTER_COMMANDS','normal',{},false);await events.emit('GENERATE_AFTER_DATA',{},false);await events.emit('GENERATION_ENDED')});
 await page.waitForTimeout(140);
 assert.equal(await page.locator('.csb-badge').innerText(),'0');
 await page.evaluate(async()=>{await events.emit('GENERATION_AFTER_COMMANDS','normal',{},false);await events.emit('GENERATION_STOPPED')});
 await page.waitForTimeout(140);
 assert.equal(await page.locator('.csb-badge').isVisible(),false);
 await page.evaluate(async()=>{await events.emit('GENERATION_AFTER_COMMANDS','normal',{},true);await events.emit('GENERATE_AFTER_DATA',{},true);await events.emit('GENERATION_AFTER_COMMANDS','quiet',{},false);await events.emit('WORLD_INFO_ACTIVATED',books);await events.emit('GENERATE_AFTER_DATA',{},false);await events.emit('GENERATION_ENDED')});
 await page.waitForTimeout(140);
 assert.equal(await page.locator('.csb-badge').isVisible(),false);
 await page.evaluate(async()=>{await events.emit('GENERATION_AFTER_COMMANDS','swipe',{},false);await events.emit('WORLD_INFO_ACTIVATED',books);await events.emit('GENERATE_AFTER_DATA',{},false);await events.emit('GENERATION_ENDED')});
 await page.waitForTimeout(140);
 for(const width of [320,390,1280]){
  await page.setViewportSize({width,height:844});
  const bounds=await page.locator('.csb-panel').boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width+1);
  const fits=await page.locator('.csb-body').evaluate(el=>el.scrollWidth<=el.clientWidth+1);assert.equal(fits,true,'no horizontal overflow');
 }
 await page.setViewportSize({width:390,height:844});
 if(process.env.CSB_SCREENSHOT_DIR){await page.screenshot({path:path.join(process.env.CSB_SCREENSHOT_DIR,'active-mobile.png')});await page.locator('[data-tab=world]').click();await page.screenshot({path:path.join(process.env.CSB_SCREENSHOT_DIR,'manage-mobile.png')})}
 // Disable removes listeners/UI, enable does not duplicate subscriptions or retain count.
 await page.evaluate(async()=>{const ext=await import('/scripts/extensions/third-party/chat-switchboard/index.js');ext.onDisable();ext.onEnable()});
 assert.equal(await page.locator('.csb-launcher').count(),1);
 assert.equal(await page.locator('.csb-badge').isVisible(),false);
 assert.deepEqual(errors,[]);
 console.log('PASS: real DOM interactions, auto-registration, scope isolation, preset adapter, zero/failure/dry-run/quiet, swipe, 320/390/1280 layouts and lifecycle');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
