/// <reference lib="webworker" />
import { queueOpened, readState, updateState } from "./storage.js";
import { flushEvents, request } from "./transport.js";
import { applicationKey, clickTarget, serializeSubscription, UUID } from "./validation.js";
declare const self: ServiceWorkerGlobalScope;

// No skipWaiting/clients.claim: the host owns its worker lifecycle and offline cache.
self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let data: Record<string, unknown>;
    try {
      const text = event.data?.text();
      if (!text || text.length > 16384) return;
      data = JSON.parse(text) as Record<string, unknown>;
      if (!data || typeof data !== "object") return;
    } catch { return; }
    const state = await readState();
    if (!state || !state.subscribed || data.pushport_app_id !== state.appId ||
      typeof data.pushport_message_id !== "string" || !UUID.test(data.pushport_message_id) || typeof data.title !== "string") return;
    const options: NotificationOptions & { image?: string } = {
      body: typeof data.body === "string" ? data.body.slice(0, 4096) : "",
      tag: `pushport:${data.pushport_message_id}`,
      data: { pushport_app_id: state.appId, pushport_message_id: data.pushport_message_id, click_url: clickTarget(data.click_url, state.origin) },
    };
    if (typeof data.image_url === "string") {
      try { const url = new URL(data.image_url); if (url.protocol === "https:" && !url.username && !url.password) options.image = url.href; } catch { /* Text still displays. */ }
    }
    await self.registration.showNotification(data.title.slice(0, 200), options);
  })());
});

self.addEventListener("notificationclick", event => {
  const data = event.notification.data as Record<string, unknown> | null;
  if (!data || typeof data.pushport_app_id !== "string" || typeof data.pushport_message_id !== "string" || !UUID.test(data.pushport_message_id)) return;
  event.notification.close();
  event.waitUntil((async () => {
    const state = await readState();
    if (!state || data.pushport_app_id !== state.appId) return;
    // Navigation does not wait for analytics/network success.
    const navigate = async () => {
      const url = clickTarget(data.click_url, state.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find(client => client.url === url);
      if (existing) await existing.focus(); else await self.clients.openWindow(url);
    };
    await Promise.allSettled([navigate(), queueOpened(state.appId, data.pushport_message_id as string).then(flushEvents)]);
  })());
});

// Some browsers do not dispatch pushsubscriptionchange; page sync also reconciles tokens.
self.addEventListener("pushsubscriptionchange", event => {
  (event as ExtendableEvent).waitUntil((async () => {
    const state = await readState();
    if (state?.subscribed && state.vapidPublicKey && state.snapshot) {
      try {
        const subscription = await self.registration.pushManager.getSubscription() ??
          await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(state.vapidPublicKey) });
        const updated = await updateState(latest => {
          if (!latest?.snapshot) throw new Error("Missing PushPort state");
          latest.snapshot = { ...latest.snapshot, revision: ++latest.revision, pushSubscribed: latest.subscribed,
            webSubscription: serializeSubscription(subscription) };
          return latest;
        });
        await request(updated, `/installations/${updated.installationId}`, "PUT", updated.snapshot, updated.secret);
      } catch { /* Durable state is retried by page sync; don't rotate installation identity. */ }
    }
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) client.postMessage({ type: "pushport:subscription-changed" });
  })());
});
