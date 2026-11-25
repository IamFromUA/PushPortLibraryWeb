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
  context = vm.createContext({ self: worker, indexedDB, URL, Intl, Uint8Array, TextDecoder, AbortController, Blob, setTimeout, clearTimeout,
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
  assert.equal(shown[0].options.data.click_url, null);
  assert.equal(shown[0].options.image, undefined);
});
test('worker stops a subscription renewal when another tab revokes consent', async () => {
  await updateState(s => { s.consentRequired = true; s.consentGiven = true; s.vapidPublicKey = Buffer.from([4, ...new Uint8Array(64)]).toString('base64url'); s.snapshot = { revision: 1 }; return s; });
  let subscriptions = 0, requests = 0;
  context.fetch = async () => { requests++; return new Response(null, { status: 204 }); };
  context.self.registration.pushManager = {
    async getSubscription() { await updateState(s => { s.consentGiven = false; return s; }); return null; },
    async subscribe() { subscriptions++; throw new Error('unexpected subscribe'); },
  };
  let task;
  callbacks.pushsubscriptionchange({ waitUntil(promise) { task = promise; } });
  await task;
  assert.equal(subscriptions, 0);
  assert.equal(requests, 0);
  assert.equal((await readState()).consentGiven, false);
  assert.equal((await readState()).snapshot.revision, 1);
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

test('a plain push opens the site without counting a campaign link or an Android icon download', async () => {
  await push({ pushport_app_id: appId, pushport_message_id: messageId, title: 'Plain', large_icon: 'ic_app' });
  let task;
  callbacks.notificationclick({ notification: { data: shown[0].options.data, close() {} }, waitUntil(p) { task = p; } });
  await task;
  assert.deepEqual(opened, ['https://site.example.test/']);
  const events = (await readState()).telemetryEvents.map(e => e.type);
  assert.ok(events.includes('clicked'));
  assert.ok(!events.some(type => /^(image_|link_)/.test(type)));
});

test('external HTTPS click records browser acceptance with an opaque WindowClient', async () => {
  const target = 'https://offers.example.com/offer?lang=de';
  let task;
  context.self.clients.openWindow = async url => { opened.push(url); return null; };
  callbacks.notificationclick({ notification: { data: { pushport_app_id: appId, pushport_message_id: messageId, click_url: target }, close() {} }, waitUntil(p) { task = p; } });
  await task;
  assert.deepEqual(opened, [target]);
  const events = (await readState()).telemetryEvents;
  assert.ok(events.some(e => e.type === 'link_opened'));
  assert.ok(!events.some(e => e.type === 'link_failed'));
});

test('picture and icon attach independently, keep the same tag and update silently', async () => {
  context.fetch = async url => {
    if (url.includes('broken')) return new Response(null, { status: 503 });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgfsAAAAASUVORK5CYII=', 'base64');
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  };
  await push({ pushport_app_id: appId, pushport_message_id: messageId, title: 'Hello', image_url: 'https://images.example.test/broken', large_icon: 'https://images.example.test/icon.png' });
  assert.equal(shown.length, 2); assert.equal(shown[1].options.tag, shown[0].options.tag);
  assert.match(shown[1].options.icon, /^data:image\/png;base64,/); assert.equal(shown[1].options.image, undefined);
  assert.equal(shown[1].options.silent, true);
  const events = (await readState()).telemetryEvents;
  assert.ok(events.some(event => event.type === 'image_failed' && event.httpStatus === 503));
  assert.ok(events.some(event => event.type === 'image_attached'));
  await push({ pushport_app_id: appId, pushport_message_id: messageId, title: 'Duplicate' }); assert.equal(shown.length, 2);
});
