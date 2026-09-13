import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { PushPort } from '../dist/index.js';

const names = ['window', 'document', 'navigator', 'location', 'Notification', 'indexedDB', 'fetch'];
const saved = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const appId = '00000000-0000-0000-0000-000000000001';
const key = new Uint8Array(65); key[0] = 4;
const encoded = Buffer.from(key).toString('base64url');
let records, promptCount, subscription, permission, unsubscribeResult, clients;
beforeEach(async () => {
  await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase('pushport-web-v1'); request.onsuccess = resolve; request.onerror = reject; });
  records = []; promptCount = 0; subscription = null; permission = 'default'; unsubscribeResult = true; clients = [];
  const makeSubscription = () => ({
    endpoint: 'https://push.example.test/synthetic', expirationTime: null,
    options: { applicationServerKey: key.buffer },
    getKey(name) { return name === 'p256dh' ? key.buffer : new Uint8Array(16).buffer; },
    async unsubscribe() { if (unsubscribeResult) subscription = null; return unsubscribeResult; },
  });
  const registration = { scope: 'https://site.example.test/', active: { scriptURL: 'https://site.example.test/pushport-sw.js' },
    pushManager: { async getSubscription() { return subscription; }, async subscribe() { subscription = makeSubscription(); return subscription; } } };
  const worker = new EventTarget();
  worker.getRegistration = async () => registration;
  worker.register = async () => registration;
  const window = new EventTarget(); window.isSecureContext = true; window.PushManager = class {};
  const Notification = class {
    static get permission() { return permission; }
    static async requestPermission() { promptCount++; permission = 'granted'; return permission; }
  };
  window.Notification = Notification;
  const document = new EventTarget(); document.visibilityState = 'visible';
  const values = { window, document, Notification, indexedDB, location: new URL('https://site.example.test/'),
    navigator: { languages: ['en-US', 'de-DE'], serviceWorker: worker, permissions: { async query() { return new EventTarget(); } } },
    fetch: async (url, options) => {
      if (options.method === 'GET') return Response.json({ appId, platform: 'WEB', protocolVersion: 1, vapidPublicKey: encoded });
      records.push({ url, body: JSON.parse(options.body), options });
      return Response.json({ installationId: url.split('/').at(-1), syncedAt: Date.now() });
    } };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
});
afterEach(() => {
  clients.forEach(client => client.dispose());
  for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
});
async function initialize() { const client = await PushPort.initialize({ appId }); clients.push(client); return client; }

test('initialize does not prompt, permission registers, opt-out removes subscription and survives reinitialization', async () => {
  const client = await initialize();
  assert.equal(promptCount, 0);
  assert.equal(records[0].body.webSubscription, null);
  assert.equal(client.status().notificationsEnabled, undefined); // API exposes the browser permission value.
  await client.requestPermission();
  assert.equal(promptCount, 1);
  assert.equal(client.status().hasToken, true);
  assert.equal(records.at(-1).body.webSubscription.endpoint, 'https://push.example.test/synthetic');
  const identity = client.status().installationId;
  await client.setSubscribed(false);
  assert.equal(subscription, null);
  assert.equal(records.at(-1).body.pushSubscribed, false);
  client.dispose();
  const restarted = await initialize();
  assert.equal(restarted.status().installationId, identity);
  assert.equal(restarted.status().subscribed, false);
  assert.equal(restarted.status().hasToken, false);
  assert.equal(promptCount, 1);
  assert.equal(JSON.stringify(restarted.status()).includes('synthetic'), false);
  assert.equal(JSON.stringify(restarted).includes('secret'), false);
});
test('locale override and reset preserve the browser language list with ordered revisions', async () => {
  const client = await initialize();
  await client.setLocale('uk-UA');
  assert.equal(records.at(-1).body.locale, 'uk-UA');
  assert.deepEqual(records.at(-1).body.systemLocales, ['en-US', 'de-DE']);
  navigator.languages = ['fr-CA'];
  await client.setLocale(null);
  assert.equal(records.at(-1).body.locale, 'fr-CA');
  assert.equal(records.at(-1).body.language, 'fr');
  assert.ok(records.every((record, i) => i === 0 || record.body.revision > records[i - 1].body.revision));
});
test('failed native unsubscribe still sends the durable opt-out to the server', async () => {
  const client = await initialize();
  await client.requestPermission();
  unsubscribeResult = false;
  await assert.rejects(client.setSubscribed(false), /could not remove/);
  assert.equal(records.at(-1).body.pushSubscribed, false);
  assert.equal(client.status().subscribed, false);
});
test('foreign service worker is never replaced by initialization', async () => {
  navigator.serviceWorker.getRegistration = async () => ({ scope: location.origin + '/', active: { scriptURL: location.origin + '/host-owned.js' } });
  await assert.rejects(initialize(), /existing service worker/);
  assert.equal(records.length, 0);
});
