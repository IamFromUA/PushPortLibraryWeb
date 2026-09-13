/** Immutable binding. Use one PushPort application per browser origin. */
export interface PushPortOptions {
  appId: string;
  serverUrl?: string;
  /** Same-origin script; copy the distributed service worker to this URL. */
  serviceWorkerUrl?: string;
  serviceWorkerScope?: string;
  /** Supply an existing worker after integrating the PushPort worker into it. */
  serviceWorkerRegistration?: ServiceWorkerRegistration;
  /** Explicit local development opt-in. HTTPS remains mandatory on public hosts. */
  allowInsecureLocalhost?: boolean;
  appVersion?: string;
}

/** Local state; a token/subscription does not prove delivery. Contains no credentials. */
export interface PushPortStatus {
  configured: boolean;
  supported: boolean;
  installationId: string | null;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  hasToken: boolean;
  locale: string;
  lastSyncedAt: number | null;
  syncError: string | null;
}

export interface WebSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export interface PlatformSnapshot {
  revision: number;
  platform: "WEB";
  applicationIdentifier: string;
  pushToken: null;
  webSubscription: WebSubscription | null;
  language: string;
  locale: string;
  appLocales: string[];
  systemLocales: string[];
  timezone: string;
  notificationsEnabled: boolean;
  pushSubscribed: boolean;
  sdkVersion: string;
  appVersion: string;
  osVersion: string;
  model: string;
}

export interface StoredState {
  schema: 1;
  appId: string;
  serverUrl: string;
  origin: string;
  vapidPublicKey: string | null;
  installationId: string;
  secret: string;
  subscribed: boolean;
  localeOverride: string | null;
  revision: number;
  snapshot: PlatformSnapshot | null;
  pendingEvents: string[];
  lastSyncedAt: number | null;
  syncError: string | null;
}

/** Safe structured error; never includes an HTTP response body or push credentials. */
export class PushPortError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = "PushPortError";
  }
}
