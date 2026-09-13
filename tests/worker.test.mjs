import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { indexedDB } from 'fake-indexeddb';
import { build } from 'esbuild';

await build({ entryPoints: ['src/storage.ts'], outfile: '.run/worker-storage.js', bundle: true, format: 'esm', platform: 'node' });
globalThis.indexedDB = indexedDB;
const { bind, readState, updateState } = await import('../.run/worker-storage.js');
const code = await readFile('dist/pushport-sw.js', 'utf8');
const appId = '00000000-0000-0000-0000-000000000001';
const messageId = '00000000-0000-0000-0000-000000000002';
let callbacks, shown, opened, online, context;
beforeEach(async () => {
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('pushport-web-v1'); request.onsuccess = resolve; request.onerror = reject; });
  await bind(appId, 'https://pushport.dev', 'https://site.example.test');
  callbacks = {}; shown = []; opened = []; online = false;
  const worker = {
    addEventListener(type, handler) { callbacks[type] = handler; },
    registration: { async showNotification(title, options) { shown.push({ title, options }); } },
    clients: { async matchAll() { return []; }, async openWindow(url) { opened.push(url); } },
  };
  context = vm.createContext({ self: worker, indexedDB, URL, Intl, Uint8Array, TextDecoder, AbortController, setTimeout, clearTimeout,
    fetch: async () => { if (!online) throw new Error('offline'); return new Response(null, { status: 204 }); },
    atob, btoa, crypto });
  vm.runInContext(code, context);
});
after(() => { delete globalThis.indexedDB; });
async function push(payload) {
  let task;
  callbacks.push({ data: { text: () => typeof payload === 'string' ? payload : JSON.stringify(payload) }, waitUntil(promise) { task = promise; } });
  await task;
}
test('worker displays only valid application payloads and constrains click URLs', async () => {
  await push(null);
  await push('{broken');
  await push({ pushport_app_id: 'another-app', pushport_message_id: messageId, title: 'Ignore' });
  assert.equal(shown.length, 0);
  await push({ pushport_app_id: appId, pushport_message_id: messageId, title: 'Hello', body: 'Body', click_url: 'javascript:alert(1)', image_url: 'http://unsafe/image.png' });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].options.data.click_url, 'https://site.example.test/');
  assert.equal(shown[0].options.image, undefined);
});
test('worker respects persisted opt-out without a live page', async () => {
  await updateState(state => { state.subscribed = false; return state; });
  await push({ pushport_app_id: appId, pushport_message_id: messageId, title: 'Muted' });
  assert.equal(shown.length, 0);
});
test('offline click still navigates and durably queues the opened event', async () => {
  let task; let closed = false;
  callbacks.notificationclick({ notification: { data: { pushport_app_id: appId, pushport_message_id: messageId, click_url: '/inbox' }, close() { closed = true; } }, waitUntil(promise) { task = promise; } });
  await task;
  assert.equal(closed, true);
  assert.deepEqual(opened, ['https://site.example.test/inbox']);
  assert.deepEqual((await readState()).pendingEvents, [messageId]);
});
