import { bind, readState, updateState } from "./storage.js";
import { flushEvents, request } from "./transport.js";
import { applicationKey, locales, normalizeLocale, SDK_VERSION, serializeSubscription, serverUrl, UUID } from "./validation.js";
import { PushPortError, type PlatformSnapshot, type PushPortOptions, type PushPortStatus, type StoredState } from "./types.js";
import { appendEvent, collectionAllowed, flushTelemetry } from "./telemetry.js";
import { enqueueUser, flushUsers, validatePatch } from "./users.js";
import { imageLimit } from "./images.js";
export { PushPortError } from "./types.js";
export type { PushPortOptions, PushPortStatus, PushPortUser, NotificationEvent, UsageSnapshot } from "./types.js";

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
  private foregroundAt: number | null = null;
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
    client.#state = await bind(options.appId, endpoint, location.origin);
    client.#state = await updateState(state => { if (!state) throw new PushPortError("storage_cleared", "Browser storage was cleared");
      if (options.consentRequired !== undefined) state.consentRequired = options.consentRequired;
      if (options.consentGiven !== undefined) state.consentGiven = options.consentGiven;
      return state; });
    if (collectionAllowed(client.#state)) await client.configure();
    client.registration = await client.prepareWorker();
    client.hasToken = !!await client.registration.pushManager.getSubscription();
    window.addEventListener("online", client.refresh);
    window.addEventListener("languagechange", client.refresh);
    navigator.serviceWorker.addEventListener("message", client.workerMessage);
    document.addEventListener("visibilitychange", client.visible);
    await client.captureSession(document.visibilityState === "visible");
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
    if (!this.#state || !collectionAllowed(this.#state)) throw new PushPortError("consent_required", "Provide consent first");
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
      if (!collectionAllowed(this.#state)) return;
      await this.configure();
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
          osVersion: "", model: "Browser", telemetryVersion: state.telemetryVersion ?? 0, ...(state.usage ? { usage: state.usage } : {}) };
        state.snapshot = snapshot; return state;
      });
      const sent = this.#state;
      await request(sent, `/installations/${sent.installationId}`, "PUT", sent.snapshot, sent.secret);
      this.#state = await updateState(state => {
        if (!state) throw new PushPortError("storage_cleared", "Browser storage was cleared");
        state.lastSyncedAt = Date.now(); state.syncError = null; return state;
      });
      await flushEvents();
      await flushUsers();
      await flushTelemetry();
      this.#state = await readState();
      this.retries = 0;
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    } catch (error) {
      const safe = error instanceof PushPortError ? error : new PushPortError("sync_failed", "PushPort synchronization failed");
      if (this.#state) {
        this.#state = await updateState(state => { if (!state) throw safe; state.syncError = safe.code;
          appendEvent(state, "sync_failed", undefined, { reason: safe.httpStatus ? "http_error" : safe.code, ...(safe.httpStatus ? { httpStatus: safe.httpStatus } : {}) }); return state; }).catch(() => this.#state);
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
    void this.captureSession(false).catch(() => {});
    this.disposed = true; if (this.timer) clearTimeout(this.timer);
    window.removeEventListener("online", this.refresh); window.removeEventListener("languagechange", this.refresh);
    navigator.serviceWorker.removeEventListener("message", this.workerMessage);
    document.removeEventListener("visibilitychange", this.visible); this.permissionListener?.removeEventListener("change", this.refresh);
    this.listeners.clear();
  }
  private refresh = (): void => { if (!this.disposed) void this.sync().catch(() => {}); };
  private workerMessage = (event: MessageEvent): void => { if (event.data?.type === "pushport:subscription-changed") this.refresh(); };
  private visible = (): void => { void this.captureSession(document.visibilityState === "visible").then(() => this.refresh()).catch(() => {}); };
  private emit(): void { for (const listener of this.listeners) { try { listener(this.status()); } catch { /* Host callback cannot break synchronization. */ } } }
  private assertActive(): void { if (this.disposed || !this.registration) throw new PushPortError("not_initialized", "Initialize an active PushPort client first"); }

  /** Last acknowledged profile; no network call and no installation secret. */
  user(): import("./types.js").PushPortUser | null { return this.#state?.user ? structuredClone(this.#state.user) : null; }
  async setConsentRequired(required: boolean): Promise<void> { this.assertActive(); this.#state = await updateState(state => { if (!state) throw new PushPortError("not_initialized", "Initialize PushPort first"); state.consentRequired = required; return state; }); await this.captureSession(false); await this.sync(); }
  async setConsentGiven(given: boolean): Promise<void> {
    this.assertActive(); this.#state = await updateState(state => { if (!state) throw new PushPortError("not_initialized", "Initialize PushPort first"); state.consentGiven = given;
      if (!collectionAllowed(state)) { state.telemetryEvents = []; state.pendingEvents = []; state.userOperations = []; } return state; });
    await this.captureSession(false); if (given) await this.captureSession(document.visibilityState === "visible"); await this.sync();
  }
  async setTags(tags: Record<string, string | null>): Promise<void> { validatePatch(tags); await this.mutateUser({ kind: "tags", tags: { ...tags } }); }
  async login(externalId: string, identityToken: string): Promise<void> {
    if (!externalId.trim() || externalId !== externalId.trim() || externalId.length > 128 || /[\x00-\x1f\x7f]/.test(externalId) || !/^[A-Za-z0-9_-]{43}$/.test(identityToken)) throw new PushPortError("invalid_identity", "Use an External ID and a short-lived identity token from your backend");
    await this.mutateUser({ kind: "login", externalId, identityToken });
  }
  async logout(): Promise<void> { await this.mutateUser({ kind: "logout" }); }
  async setEmail(email: string | null): Promise<void> { if (email !== null && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new PushPortError("invalid_email", "Invalid email"); await this.mutateUser({ kind: "email", email }); }
  async setPhoneNumber(phoneNumber: string | null): Promise<void> { if (phoneNumber !== null && !/^\+[1-9][0-9]{6,14}$/.test(phoneNumber)) throw new PushPortError("invalid_phone", "Use E.164 phone format"); await this.mutateUser({ kind: "phone", phoneNumber }); }
  async setLocation(latitude: number | null, longitude: number | null): Promise<void> { if ((latitude === null) !== (longitude === null) || (latitude !== null && (!Number.isFinite(latitude) || Math.abs(latitude) > 90)) || (longitude !== null && (!Number.isFinite(longitude) || Math.abs(longitude) > 180))) throw new PushPortError("invalid_location", "Invalid coordinates"); await this.mutateUser({ kind: "location", latitude, longitude }); }
  async trackEvent(eventName: string, eventProperties: Record<string, string> = {}): Promise<void> { if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(eventName)) throw new PushPortError("invalid_event", "Invalid event name"); validatePatch(eventProperties, 20); await this.mutateUser({ kind: "event", eventName, eventProperties: { ...eventProperties } }); }
  private async mutateUser(operation: Omit<import("./types.js").UserOperation, "revision">): Promise<void> { this.assertActive(); await enqueueUser(operation); await this.sync(); }
  private async configure(): Promise<void> {
    const state = this.#state!;
    const config = await request(state, `/config?origin=${encodeURIComponent(state.origin)}`) as Record<string, unknown> | null;
    if (!config || config.appId !== state.appId || config.platform !== "WEB" || config.protocolVersion !== 1 || typeof config.vapidPublicKey !== "string") throw new PushPortError("not_configured", "Configure Web Push for this origin in PushPort first");
    this.key = applicationKey(config.vapidPublicKey);
    this.#state = await updateState(latest => { if (!latest) throw new PushPortError("storage_cleared", "Browser storage was cleared"); latest.vapidPublicKey = config.vapidPublicKey as string; latest.telemetryVersion = config.telemetryVersion === 1 ? 1 : 0; latest.userProfileVersion = config.userProfileVersion === 1 ? 1 : 0; latest.imageLimitBytes = imageLimit(config.imageLimitBytes); return latest; });
  }
  private async captureSession(visible: boolean): Promise<void> {
    const was = this.foregroundAt; const now = performance.now();
    if (visible === (was !== null)) return;
    this.foregroundAt = visible ? now : null;
    await updateState(state => {
      if (!state) throw new PushPortError("not_initialized", "Initialize PushPort first"); if (!collectionAllowed(state)) { this.foregroundAt = null; return state; }
      const wall = Date.now(); const usage = state.usage ??= { firstSessionAt: null, lastSessionAt: null, sessionCount: 0, totalUsageMillis: 0 };
      if (visible && (!usage.sessionCount || wall - (state.lastActivityAt ?? 0) >= 30000 || wall < (state.lastActivityAt ?? 0))) {
        usage.firstSessionAt ??= wall; usage.lastSessionAt = Math.max(wall, usage.lastSessionAt ?? wall); usage.sessionCount++;
        const direct = state.lastClicked && wall - state.lastClicked.at >= 0 && wall - state.lastClicked.at <= 60000;
        const influenced = state.lastReceived && state.lastReceived.messageId !== state.lastClicked?.messageId && wall - state.lastReceived.at >= 0 && wall - state.lastReceived.at <= 3600000;
        appendEvent(state, "session_started", direct ? state.lastClicked?.messageId : influenced ? state.lastReceived?.messageId : undefined, { reason: direct ? "direct" : influenced ? "influenced" : "organic" });
      } else if (!visible && was !== null) {
        const duration = Math.min(604800000, Math.max(0, Math.round(now - was))); usage.totalUsageMillis += duration; appendEvent(state, "session_ended", undefined, { durationMillis: duration });
      }
      state.lastActivityAt = wall; return state;
    });
  }
}
