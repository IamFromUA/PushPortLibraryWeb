import { bind, readState, updateState } from "./storage.js";
import { flushEvents, request } from "./transport.js";
import { applicationKey, locales, normalizeLocale, SDK_VERSION, serializeSubscription, serverUrl, UUID } from "./validation.js";
import { PushPortError, type PlatformSnapshot, type PushPortOptions, type PushPortStatus, type StoredState } from "./types.js";
export { PushPortError } from "./types.js";
export type { PushPortOptions, PushPortStatus } from "./types.js";

/** Import is SSR-safe. Initialize in a browser, then request permission from a click. */
export class PushPort {
  #state: StoredState | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private key: Uint8Array<ArrayBuffer> | null = null;
  private listeners = new Set<(status: PushPortStatus) => void>();
  private pending: Promise<void> = Promise.resolve();
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private hasToken = false;
  private permissionListener: PermissionStatus | null = null;
  private constructor(private readonly options: PushPortOptions) {}

  static isSupported(): boolean {
    return typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator &&
      "PushManager" in window && "Notification" in window && typeof indexedDB !== "undefined";
  }

  /** Does not display a permission prompt. Fails explicitly on unsupported browsers. */
  static async initialize(options: PushPortOptions): Promise<PushPort> {
    if (!UUID.test(options.appId)) throw new PushPortError("invalid_app_id", "Use the canonical App ID from PushPort");
    if (!PushPort.isSupported()) throw new PushPortError("unsupported", "This browser/context does not support Web Push");
    const client = new PushPort(options);
    const endpoint = serverUrl(options.serverUrl ?? "https://pushport.dev", options.allowInsecureLocalhost);
    const config = await request({ appId: options.appId, serverUrl: endpoint }, `/config?origin=${encodeURIComponent(location.origin)}`) as Record<string, unknown> | null;
    if (!config || config.appId !== options.appId || config.platform !== "WEB" || config.protocolVersion !== 1 ||
      typeof config.vapidPublicKey !== "string") throw new PushPortError("not_configured", "Configure Web Push for this origin in PushPort first");
    client.key = applicationKey(config.vapidPublicKey);
    client.#state = await bind(options.appId, endpoint, location.origin);
    const publicKey = config.vapidPublicKey;
    client.#state = await updateState(state => { if (!state) throw new PushPortError("storage_cleared", "Browser storage was cleared"); state.vapidPublicKey = publicKey; return state; });
    client.registration = await client.prepareWorker();
    client.hasToken = !!await client.registration.pushManager.getSubscription();
    window.addEventListener("online", client.refresh);
    window.addEventListener("languagechange", client.refresh);
    navigator.serviceWorker.addEventListener("message", client.workerMessage);
    document.addEventListener("visibilitychange", client.visible);
    try {
      client.permissionListener = await navigator.permissions.query({ name: "notifications" as PermissionName });
      client.permissionListener.addEventListener("change", client.refresh);
    } catch { /* Safari: visibility refresh also detects changed permission. */ }
    await client.sync().catch(() => { /* Persisted error is available through status; a retry is scheduled. */ });
    return client;
  }

  private async prepareWorker(): Promise<ServiceWorkerRegistration> {
    if (this.options.serviceWorkerRegistration) return this.options.serviceWorkerRegistration;
    const script = new URL(this.options.serviceWorkerUrl ?? "/pushport-sw.js", location.href);
    const scope = new URL(this.options.serviceWorkerScope ?? "./", script);
    if (script.origin !== location.origin || scope.origin !== location.origin || script.search || script.hash) {
      throw new PushPortError("invalid_worker", "Use a same-origin service worker URL and scope");
    }
    const existing = await navigator.serviceWorker.getRegistration(scope.href);
    const existingScript = existing?.active?.scriptURL ?? existing?.waiting?.scriptURL ?? existing?.installing?.scriptURL;
    if (existingScript && existingScript !== script.href && existing?.scope === scope.href) {
      throw new PushPortError("worker_conflict", "Integrate PushPort into the existing service worker and pass its registration");
    }
    const registration = await navigator.serviceWorker.register(script.href, { scope: scope.href });
    if (registration.active) return registration;
    const worker = registration.installing ?? registration.waiting;
    if (!worker) throw new PushPortError("worker_unavailable", "Service worker did not install");
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timeout); worker.removeEventListener("statechange", changed); };
      const changed = () => {
        if (worker.state === "activated") { cleanup(); resolve(); }
        else if (worker.state === "redundant") { cleanup(); reject(new PushPortError("worker_unavailable", "Service worker installation failed")); }
      };
      const timeout = setTimeout(() => { cleanup(); reject(new PushPortError("worker_timeout", "Service worker activation timed out")); }, 15000);
      worker.addEventListener("statechange", changed); changed();
    });
    return registration;
  }

  status(): PushPortStatus {
    return { configured: this.#state !== null, supported: PushPort.isSupported(), installationId: this.#state?.installationId ?? null,
      permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
      subscribed: this.#state?.subscribed ?? true, hasToken: this.hasToken,
      locale: this.#state?.localeOverride ?? locales(typeof navigator === "undefined" ? [] : navigator.languages)[0]!,
      lastSyncedAt: this.#state?.lastSyncedAt ?? null, syncError: this.#state?.syncError ?? null };
  }

  /** Subscribe to local changes; returns a cleanup function. */
  onStatusChange(listener: (status: PushPortStatus) => void): () => void {
    this.listeners.add(listener); listener(this.status()); return () => this.listeners.delete(listener);
  }

  /** Call directly from a user click. A previous browser denial cannot be bypassed. */
  async requestPermission(): Promise<NotificationPermission> {
    this.assertActive();
    const result = await Notification.requestPermission();
    if (result === "granted" && this.#state?.subscribed) await this.ensureSubscription();
    await this.sync();
    return result;
  }

  async setSubscribed(subscribed: boolean): Promise<void> {
    this.assertActive();
    this.#state = await updateState(state => { if (!state) throw new PushPortError("not_initialized", "Initialize PushPort first"); state.subscribed = subscribed; return state; });
    this.emit();
    if (!subscribed) {
      const current = await this.registration!.pushManager.getSubscription();
      try {
        if (current && !await current.unsubscribe()) throw new PushPortError("unsubscribe_failed", "Browser could not remove the push subscription; retry");
      } catch (error) { await this.sync().catch(() => {}); throw error; }
    } else if (Notification.permission === "granted") await this.ensureSubscription();
    await this.sync();
  }

  async setLocale(value: string | null): Promise<void> {
    this.assertActive();
    const tag = value === null ? null : normalizeLocale(value);
    this.#state = await updateState(state => { if (!state) throw new PushPortError("not_initialized", "Initialize PushPort first"); state.localeOverride = tag; return state; });
    await this.sync();
  }

  /** Explicit retry; offline updates remain persisted. Safe to call repeatedly. */
  sync(): Promise<void> {
    this.assertActive();
    const work = this.pending.catch(() => {}).then(() => this.synchronize());
    this.pending = work; return work;
  }

  private async ensureSubscription(): Promise<PushSubscription> {
    const current = await this.registration!.pushManager.getSubscription();
    if (current) {
      const used = current.options.applicationServerKey;
      if (used && (used.byteLength !== this.key!.length || new Uint8Array(used).some((byte, i) => byte !== this.key![i]))) {
        throw new PushPortError("vapid_key_conflict", "An existing subscription uses another VAPID key; migrate it explicitly before subscribing");
      }
      return current;
    }
    return this.registration!.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: this.key! });
  }

  private async synchronize(): Promise<void> {
    if (this.disposed) return;
    try {
      this.#state = await readState();
      if (!this.#state) throw new PushPortError("storage_cleared", "Browser storage was cleared; initialize PushPort again");
      let subscription = await this.registration!.pushManager.getSubscription();
      if (this.#state.subscribed && Notification.permission === "granted") subscription = await this.ensureSubscription();
      this.hasToken = !!subscription;
      const systemLocales = locales(navigator.languages);
      this.#state = await updateState(state => {
        if (!state) throw new PushPortError("storage_cleared", "Browser storage was cleared");
        const locale = state.localeOverride ?? systemLocales[0]!;
        const snapshot: PlatformSnapshot = { revision: ++state.revision, platform: "WEB", applicationIdentifier: location.origin,
          pushToken: null, webSubscription: subscription ? serializeSubscription(subscription) : null,
          language: new Intl.Locale(locale).language, locale, appLocales: [locale], systemLocales,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", notificationsEnabled: Notification.permission === "granted",
          pushSubscribed: state.subscribed, sdkVersion: SDK_VERSION, appVersion: (this.options.appVersion ?? "").slice(0, 100),
          osVersion: "", model: "Browser" };
        state.snapshot = snapshot; return state;
      });
      const sent = this.#state;
      await request(sent, `/installations/${sent.installationId}`, "PUT", sent.snapshot, sent.secret);
      this.#state = await updateState(state => {
        if (!state) throw new PushPortError("storage_cleared", "Browser storage was cleared");
        state.lastSyncedAt = Date.now(); state.syncError = null; return state;
      });
      await flushEvents();
      this.retries = 0;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    } catch (error) {
      const safe = error instanceof PushPortError ? error : new PushPortError("sync_failed", "PushPort synchronization failed");
      if (this.#state) {
        this.#state = await updateState(state => { if (!state) throw safe; state.syncError = safe.code; return state; }).catch(() => this.#state);
      }
      if ((safe.code === "network_error" || safe.httpStatus === 409 || safe.httpStatus === 429 || (safe.httpStatus ?? 0) >= 500) && !this.disposed && this.retries < 6) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(this.refresh, Math.min(60000, 1000 * 2 ** this.retries++) + Math.random() * 500);
      }
      throw safe;
    } finally { this.emit(); }
  }

  /** Stops observers/retries. Does not unsubscribe or erase the durable identity. */
  dispose(): void {
    this.disposed = true; if (this.timer) clearTimeout(this.timer);
    window.removeEventListener("online", this.refresh); window.removeEventListener("languagechange", this.refresh);
    navigator.serviceWorker.removeEventListener("message", this.workerMessage);
    document.removeEventListener("visibilitychange", this.visible); this.permissionListener?.removeEventListener("change", this.refresh);
    this.listeners.clear();
  }
  private refresh = (): void => { if (!this.disposed) void this.sync().catch(() => {}); };
  private workerMessage = (event: MessageEvent): void => { if (event.data?.type === "pushport:subscription-changed") this.refresh(); };
  private visible = (): void => { if (document.visibilityState === "visible") this.refresh(); };
  private emit(): void { for (const listener of this.listeners) { try { listener(this.status()); } catch { /* Host callback cannot break synchronization. */ } } }
  private assertActive(): void { if (this.disposed || !this.registration) throw new PushPortError("not_initialized", "Initialize an active PushPort client first"); }
}
