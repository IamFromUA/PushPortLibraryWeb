/// <reference lib="webworker" />
import { queueOpened, readState, updateState } from "./storage.js";
import { flushEvents, request } from "./transport.js";
import { applicationKey, clickTarget, serializeSubscription, UUID } from "./validation.js";
import { appendEvent, collectionAllowed, flushTelemetry, record } from "./telemetry.js";
import { downloadImage, imageLimit } from "./images.js";
import { PushPortError } from "./types.js";
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
    if (!state || !collectionAllowed(state) || data.pushport_app_id !== state.appId ||
      typeof data.pushport_message_id !== "string" || !UUID.test(data.pushport_message_id) || typeof data.title !== "string") return;
    const messageId = data.pushport_message_id;
    let duplicate = false;
    const captured = await updateState(latest => {
      if (!latest) throw new Error("Missing state");
      duplicate = latest.receivedMessages?.includes(messageId) === true;
      if (!duplicate && collectionAllowed(latest)) {
        latest.receivedMessages = [...(latest.receivedMessages ?? []), messageId].slice(-200);
        latest.lastReceived = { messageId, at: Date.now() }; appendEvent(latest, "received", messageId);
      }
      return latest;
    });
    if (duplicate || !collectionAllowed(captured)) return;
    if (!captured.subscribed) { await record("not_displayed", messageId, { reason: "unsubscribed" }); await flushTelemetry().catch(() => {}); return; }
    const options: NotificationOptions & { image?: string } = {
      body: typeof data.body === "string" ? data.body.slice(0, 4096) : "",
      tag: `pushport:${data.pushport_message_id}`,
      data: { pushport_app_id: state.appId, pushport_message_id: data.pushport_message_id, click_url: clickTarget(data.click_url, state.origin) },
    };
    try { await self.registration.showNotification(data.title.slice(0, 200), options); await record("posted", messageId); }
    catch { await record("not_displayed", messageId, { reason: "notification_error" }); await flushTelemetry().catch(() => {}); return; }
    // Text appears first. Download failures never remove it; replacement is silent.
    let attached = false;
    for (const [field, target] of [["image_url", "image"], ["large_icon", "icon"]] as const) {
      if (typeof data[field] !== "string") continue;
      try {
        const downloaded = await downloadImage(data[field], imageLimit(data.image_limit_bytes ?? captured.imageLimitBytes), target === "icon");
        options[target] = downloaded.url; attached = true;
        await record("image_downloaded", messageId, { reason: target === "icon" ? "large_icon" : "picture", durationMillis: downloaded.duration, sizeBytes: downloaded.size, httpStatus: downloaded.status });
      } catch (error) {
        await record("image_failed", messageId, { reason: error instanceof PushPortError ? error.code : "decode_failed", ...(error instanceof PushPortError && error.httpStatus ? { httpStatus: error.httpStatus } : {}) });
      }
    }
    if (attached) {
      const latest = await readState();
      const active = typeof self.registration.getNotifications === "function" ? (await self.registration.getNotifications({ tag: `pushport:${messageId}` })).length > 0 : true;
      if (latest && latest.subscribed && collectionAllowed(latest) && latest.lastClicked?.messageId !== messageId && active) {
        try { await self.registration.showNotification(data.title.slice(0, 200), { ...options, silent: true }); await record("image_attached", messageId); }
        catch { await record("image_failed", messageId, { reason: "notification_error" }); }
      } else await record("image_skipped", messageId, { reason: "notification_inactive" });
    }
    await flushTelemetry().catch(() => {});
  })());
});

self.addEventListener("notificationclick", event => {
  const data = event.notification.data as Record<string, unknown> | null;
  if (!data || typeof data.pushport_app_id !== "string" || typeof data.pushport_message_id !== "string" || !UUID.test(data.pushport_message_id)) return;
  event.notification.close();
  event.waitUntil((async () => {
    const state = await readState();
    if (!state || data.pushport_app_id !== state.appId) return;
    if (collectionAllowed(state)) await updateState(latest => { if (!latest) throw new Error("Missing state"); latest.lastClicked = { messageId: data.pushport_message_id as string, at: Date.now() }; appendEvent(latest, "clicked", data.pushport_message_id as string); return latest; });
    // Navigation does not wait for analytics/network success.
    const navigate = async () => {
      const url = clickTarget(data.click_url, state.origin);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find(client => client.url === url);
      try {
        const launched = existing ? await existing.focus() : await self.clients.openWindow(url);
        await record(launched ? "link_opened" : "link_failed", data.pushport_message_id as string, launched ? {} : { reason: "no_handler" });
      } catch { await record("link_failed", data.pushport_message_id as string, { reason: "no_handler" }); }
    };
    await Promise.allSettled([navigate(), collectionAllowed(state) ? queueOpened(state.appId, data.pushport_message_id as string).then(flushEvents) : Promise.resolve()]);
    await flushTelemetry().catch(() => {});
  })());
});

// Some browsers do not dispatch pushsubscriptionchange; page sync also reconciles tokens.
self.addEventListener("pushsubscriptionchange", event => {
  (event as ExtendableEvent).waitUntil((async () => {
    const state = await readState();
    if (state?.subscribed && collectionAllowed(state) && state.vapidPublicKey && state.snapshot) {
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
