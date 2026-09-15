import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual read coordinator without requiring a running ST server.
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const coordinator = source.slice(source.indexOf('async function refreshWorlds()'), source.indexOf('function scheduleRefresh()'));
let chat = 'A', calls = 0, gate = null;
const env = vm.createContext({ active: true, hasWorldHook: true, worldRead: null, refreshToken: 0,
    worldCatalog: [], worldReadError: '', chatKey: () => chat, render() {},
    getSortedEntries: async () => { calls++; if (gate) await gate; },
});
vm.runInContext(coordinator, env);
let reject;
gate = new Promise((_, no) => { reject = no; });
const first = env.refreshWorlds(), second = env.refreshWorlds();
assert.equal(calls, 1);
reject(new Error('read failed'));
assert.ok((await Promise.allSettled([first, second])).every(x => x.status === 'fulfilled'));
assert.ok(env.worldReadError.includes('read failed'));
assert.equal(env.worldRead, null);
gate = null; await env.refreshWorlds();
assert.equal(env.worldReadError, ''); assert.equal(calls, 2);

gate = new Promise((_, no) => { reject = no; });
const oldChat = env.refreshWorlds();
chat = 'B'; env.refreshToken++;
const newChat = env.refreshWorlds();
gate = null; reject(new Error('stale read'));
await Promise.all([oldChat, newChat]);
assert.equal(calls, 4, 'old read and one shared retry for the new chat');
assert.equal(env.worldReadError, '');

gate = new Promise((_, no) => { reject = no; });
const pending = env.refreshWorlds();
env.active = false; env.refreshToken++;
gate = null; reject(new Error('disabled'));
await pending; assert.equal(calls, 5, 'no retry after disable');
assert.equal(env.worldReadError, '');
console.log('PASS: concurrent read failure, retry, stale chat, disable');
