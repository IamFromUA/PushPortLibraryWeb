# PushPort Web SDK

Native Web Push registration, locale/subscription synchronization and a service worker for notifications. TypeScript, framework independent, no runtime dependencies. ESM, CommonJS and a plain browser bundle are built from the same sources. SSR-safe import.

**Version 0.0.1 вЂ” not published.** The new backend registration routes and VAPID provisioning are prepared locally. The production server and APNs/Web sender are not commissioned yet; real end-to-end sending is a separate integration step.

## Install and initialize

From the GitHub 0.0.1 release archive:

```sh
npm install https://github.com/IamFromUA/PushPortLibraryWeb/releases/download/0.0.1/pushport-web-sdk-0.0.1.tgz
```

After npm publication: `npm install @pushport/web-sdk@0.0.1`. Both methods install the same regular dependency and TypeScript declarations. Source builds use `npm ci && npm pack`.

Copy `node_modules/@pushport/web-sdk/dist/pushport-sw.js` to your site's **public/pushport-sw.js** so it is served as JavaScript from your own origin.

```ts
import { PushPort } from '@pushport/web-sdk';

if (PushPort.isSupported()) {
  const push = await PushPort.initialize({
    appId: 'YOUR_PUSHPORT_APP_ID',
    serviceWorkerUrl: '/pushport-sw.js',
    appVersion: '1.0',
  });

  // Initialization never displays a permission prompt. Call directly from a user's click.
  document.querySelector<HTMLButtonElement>('#enable-push')!.onclick = () => {
    void push.requestPermission().catch(error => {
      document.querySelector('#push-status')!.textContent = error.message;
    });
  };
  push.onStatusChange(status => {
    document.querySelector('#push-status')!.textContent =
      `${status.permission} · ${status.hasToken ? 'subscribed' : 'no subscription'}`;
  });
  // await push.setSubscribed(false); // Unsubscribe in browser and sync preference.
  // await push.setSubscribed(true);  // Permission must already be granted.
  // await push.setLocale('de-DE');    // null restores automatic locale detection.
  // await push.sync();
  // push.dispose();                  // Stop page observers; keep the subscription/identity.
}
```

For a plain `<script>`, serve `dist/pushport.js` and use `PushPortWeb.PushPort.initialize(...)`. The worker can use `importScripts('/vendor/pushport/pushport-sw.js')` in a host-owned worker. If you already have a service worker, integrate that script and pass `serviceWorkerRegistration` to initialize; the SDK rejects taking over an existing worker at the same scope. It does not call skipWaiting or clients.claim.

The example expects `<button id="enable-push">Enable notifications</button>` and `<p id="push-status" role="status"></p>`. Build/deploy the copied worker with your application; do not fetch executable workers from an unrelated CDN at runtime.

## Behavior and requirements

- HTTPS secure context and browser support for Service Worker, PushManager, Notifications and IndexedDB. Explicit localhost HTTP is supported for the API URL only with `allowInsecureLocalhost: true`; the browser still enforces its secure-context rules.
- Configure the exact website origin in PushPort. CORS permits only that origin, without cookies. A random installation secret authorizes SDK requests; the public App ID is not a user session.
- One application/server binding per origin. Data is in IndexedDB, shared transactionally between tabs and the worker. Clearing site data creates a new installation. No fingerprint or cross-site identifier is collected.
- Browser permission and subscription preference are independent. Denial must be changed through browser settings. Re-enabling the preference does not silently display a permission prompt.
- Locale, languages, timezone, permission and subscription changes synchronize on visibility, online and language events; explicit overrides are supported. Some background subscription changes can be reconciled by the worker. Remaining updates resume when a page opens.
- Clicks stay within the configured website origin. Unknown provider payloads are ignored. Notification images must use HTTPS and are rendered only by browsers supporting them.
- The worker records opened events in a bounded durable queue (100). A click opens/focuses the page without waiting for analytics. Browsers/OS decide when notifications can run; no permanent background execution is promised.
- Safari on iOS/iPadOS requires a supported installed Home Screen web app for Web Push. Browser feature detection and real-device testing remain necessary. [WebKit documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

`status()` exposes no endpoint, encryption keys or installation secret. This is subscription-level information, not a count of distinct people.

## Development

`npm ci && npm run check && npm test && npm pack --dry-run`

The tests use synthetic subscriptions and fake IndexedDB/transport. They do not contact a push provider. Verify actual Chrome/Firefox/Safari behavior before release. [Protocol](docs/protocol.md), [architecture](docs/architecture.md), [publication](docs/publishing.md), [security](SECURITY.md).

Apache-2.0 В· Oleh Yurkov В· support@pushport.dev
