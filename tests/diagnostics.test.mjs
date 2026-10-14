import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { indexedDB } from 'fake-indexeddb';

await build({ entryPoints: ['src/storage.ts', 'src/telemetry.ts', 'src/users.ts', 'src/images.ts'], outdir: '.run/diagnostics', bundle: true, format: 'esm', platform: 'node' });
const storage = await import('../.run/diagnostics/storage.js');
const telemetry = await import('../.run/diagnostics/telemetry.js');
const users = await import('../.run/diagnostics/users.js');
const images = await import('../.run/diagnostics/images.js');
const appId = '00000000-0000-4000-8000-000000000001';
const saved = globalThis.fetch;
globalThis.indexedDB = indexedDB;
beforeEach(async () => {
  await new Promise((resolve, reject) => { const r = indexedDB.deleteDatabase('pushport-web-v1'); r.onsuccess = resolve; r.onerror = reject; });
  await storage.bind(appId, 'https://pushport.dev', 'https://site.example.test');
});
after(() => { globalThis.fetch = saved; delete globalThis.indexedDB; });

test('telemetry batches retry stable IDs and acknowledge only submitted events', async () => {
  await storage.updateState(state => { state.telemetryVersion = 1; for (let i = 0; i < 105; i++) telemetry.appendEvent(state, 'session_started', undefined, { reason: 'organic' }); return state; });
  const ids = (await storage.readState()).telemetryEvents.map(event => event.id);
  globalThis.fetch = async () => { throw Error('offline'); };
  await assert.rejects(telemetry.flushTelemetry());
  assert.deepEqual((await storage.readState()).telemetryEvents.map(event => event.id), ids);
  const batches = [];
  globalThis.fetch = async (url, options) => { const body = JSON.parse(options.body); batches.push(body.events); return Response.json({ acceptedIds: body.events.map(event => event.id) }); };
  await telemetry.flushTelemetry();
  assert.deepEqual(batches.map(batch => batch.length), [100, 5]);
  assert.deepEqual(batches.flatMap(batch => batch.map(event => event.id)), ids);
  assert.equal((await storage.readState()).telemetryEvents.length, 0);
});
test('outbox is bounded, consent blocks recording and legacy servers disable diagnostics', async () => {
  await storage.updateState(state => { state.telemetryVersion = 1; for (let i = 0; i < 1005; i++) telemetry.appendEvent(state, 'session_started'); return state; });
  assert.equal((await storage.readState()).telemetryEvents.length, 1000);
  assert.equal((await storage.readState()).droppedEvents, 5);
  globalThis.fetch = async () => new Response(null, { status: 404 });
  await telemetry.flushTelemetry(); assert.equal((await storage.readState()).telemetryVersion, 0);
  await storage.updateState(state => { state.consentRequired = true; state.consentGiven = false; return state; });
  await telemetry.record('session_started'); assert.equal((await storage.readState()).telemetryEvents.length, 1000);
  await assert.rejects(users.enqueueUser({ kind: 'tags', tags: { buyer: 'team1' } }), /consent/);
});
test('tags retain revisions across retries and an account switch drops old unsent mutations', async () => {
  await users.enqueueUser({ kind: 'tags', tags: { buyer: 'team1', remove: null } });
  await users.enqueueUser({ kind: 'event', eventName: 'custom' });
  await users.enqueueUser({ kind: 'logout' });
  const state = await storage.readState(); assert.equal(state.userOperations.length, 1); assert.equal(state.userOperations[0].revision, 3);
  await storage.updateState(state => { state.userProfileVersion = 1; return state; });
  globalThis.fetch = async () => Response.json({ userId: appId, externalId: null, revision: 3, properties: { tags: { install: 'true' } } });
  await users.flushUsers(); assert.equal((await storage.readState()).userOperations.length, 0);
  assert.equal((await storage.readState()).user.userId, appId);
  assert.throws(() => users.validatePatch({ ['x'.repeat(65)]: 'value' }));
});
test('images reject unsafe URLs, HTTP errors, MIME mismatches and streamed oversize data', async () => {
  await assert.rejects(images.downloadImage('http://example.test/image', 5 * 1024 * 1024), error => error.code === 'invalid_url');
  globalThis.fetch = async () => new Response(null, { status: 503 });
  await assert.rejects(images.downloadImage('https://example.test/image', 5 * 1024 * 1024), error => error.code === 'http_error' && error.httpStatus === 503);
  globalThis.fetch = async () => new Response('HTML', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(images.downloadImage('https://example.test/image', 100), error => error.code === 'unsupported_content_type');
  globalThis.fetch = async () => new Response(new Uint8Array(101), { headers: { 'Content-Type': 'image/png' } });
  await assert.rejects(images.downloadImage('https://example.test/image', 100), error => error.code === 'too_large');
  assert.equal(images.imageLimit(1024), 5 * 1024 * 1024); assert.equal(images.imageLimit(20 * 1024 * 1024), 20 * 1024 * 1024);
});
