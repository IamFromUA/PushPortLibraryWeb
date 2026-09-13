import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { indexedDB } from 'fake-indexeddb';
globalThis.indexedDB = indexedDB;

await build({ entryPoints: ['src/storage.ts', 'src/validation.ts', 'src/transport.ts'], outdir: '.run/test', bundle: true, format: 'esm', platform: 'node' });
const storage = await import('../.run/test/storage.js');
const validation = await import('../.run/test/validation.js');
const transport = await import('../.run/test/transport.js');
const appId = '6d632180-a023-4101-a4b1-9068404346f8';
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('pushport-web-v1'); request.onsuccess = resolve; request.onerror = reject; });
});
after(() => { globalThis.fetch = originalFetch; });

test('package import is safe during SSR', async () => {
  const { PushPort } = await import('../dist/index.js');
  assert.equal(PushPort.isSupported(), false);
});
test('identity is stable, cryptographic and rejects rebinding', async () => {
  const first = await storage.bind(appId, 'https://pushport.dev', 'https://example.test');
  const second = await storage.bind(appId, 'https://pushport.dev', 'https://example.test');
  assert.equal(first.installationId, second.installationId);
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/);
  await assert.rejects(storage.bind(crypto.randomUUID(), 'https://pushport.dev', 'https://example.test'), /already bound/);
});
test('cross-tab updates atomically preserve revisions and opt-out', async () => {
  await storage.bind(appId, 'https://pushport.dev', 'https://example.test');
  await Promise.all(Array.from({ length: 20 }, (_, i) => storage.updateState(state => {
    state.revision++; if (i === 5) state.subscribed = false; return state;
  })));
  assert.equal((await storage.readState()).revision, 20);
  assert.equal((await storage.readState()).subscribed, false);
});
test('event outbox deduplicates and never accepts another app', async () => {
  await storage.bind(appId, 'https://pushport.dev', 'https://example.test');
  const messageId = crypto.randomUUID();
  await Promise.all([storage.queueOpened(appId, messageId), storage.queueOpened(appId, messageId)]);
  assert.deepEqual((await storage.readState()).pendingEvents, [messageId]);
  await assert.rejects(storage.queueOpened(crypto.randomUUID(), messageId), /not initialized/);
});
test('transport omits cookies and forbids redirects; retries preserve events', async () => {
  await storage.bind(appId, 'https://pushport.dev', 'https://example.test');
  const messageId = crypto.randomUUID();
  await storage.queueOpened(appId, messageId);
  let responseCode = 503;
  globalThis.fetch = async (url, options) => {
    assert.ok(url.includes(`/platforms/web/installations/`));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.match(options.headers.Authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
    return new Response(null, { status: responseCode });
  };
  await assert.rejects(transport.flushEvents(), /503/);
  assert.equal((await storage.readState()).pendingEvents.length, 1);
  responseCode = 204;
  await transport.flushEvents();
  assert.deepEqual((await storage.readState()).pendingEvents, []);
});
test('unsafe config and click URLs are rejected or constrained to the website', () => {
  assert.throws(() => validation.serverUrl('https://user:secret@host.test'));
  assert.throws(() => validation.serverUrl('http://host.test', true));
  assert.equal(validation.serverUrl('http://localhost:15793/', true), 'http://localhost:15793');
  assert.equal(validation.clickTarget('javascript:alert(1)', 'https://example.test'), 'https://example.test/');
  assert.equal(validation.clickTarget('https://phishing.test', 'https://example.test'), 'https://example.test/');
  assert.equal(validation.clickTarget('/inbox', 'https://example.test'), 'https://example.test/inbox');
});
test('locales canonicalize and malformed VAPID keys fail before subscribe', () => {
  assert.deepEqual(validation.locales(['de-de', 'uk-UA', 'de-DE', 'invalid_locale']), ['de-DE', 'uk-UA']);
  assert.throws(() => validation.normalizeLocale('und'));
  assert.throws(() => validation.applicationKey('invalid'));
  const key = new Uint8Array(65); key[0] = 4;
  assert.deepEqual(validation.applicationKey(validation.base64url(key)), key);
});
