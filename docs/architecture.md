# Architecture

`index.ts` owns the page lifecycle and public API. `storage.ts` commits cross-tab/worker changes transactionally. `transport.ts` sends idempotent installation snapshots and opened events without cookies/redirects. `validation.ts` validates configuration, locale, VAPID keys and click destinations. `worker.ts` handles native push/click/subscription-change events.

Browser subscription is kept distinct from application preference and permission. Revisions are generated atomically in IndexedDB, so an older tab cannot overwrite a newer server snapshot. The latest local snapshot survives request failure. Local retry is capped, then online/foreground/manual sync resumes work. The worker's lifecycle stays under the host's control.

The SDK stores App ID/server/origin, random installation identity/secret, browser push subscription, locale override and bounded pending events. Treat origin scripts and XSS prevention as the trust boundary: IndexedDB is available to other scripts on that same origin. The SDK never puts secrets in query parameters, status objects or normal errors.

Permission requires a user gesture. This API intentionally separates initialize, requestPermission and setSubscribed. All changes return a promise; successful server synchronization is visible as lastSyncedAt. A browser subscription is not proof that a particular notification arrived.

The server must verify the exact registered origin, installation secret, monotonic revision and subscription shape. It must constrain destinations before outbound Web Push delivery (including DNS/IP checks against SSRF), encrypt Web Push payloads and sign VAPID. Client validation is not a replacement for those server responsibilities. The backend implements Web Push encryption and VAPID delivery. Enable Web Push in the application settings and verify browser permission, worker scope and real delivery separately.
