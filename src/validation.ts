import { PushPortError, type WebSubscription } from "./types.js";

export const SDK_VERSION = "0.0.1";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function serverUrl(value: string, local = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new PushPortError("invalid_config", "Use an absolute HTTPS server URL"); }
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (local && url.protocol === "http:" && localHosts.has(url.hostname)))) {
    throw new PushPortError("invalid_config", "HTTPS is required; HTTP is limited to explicitly enabled localhost");
  }
  return url.href.replace(/\/+$/, "");
}

export function normalizeLocale(value: string): string {
  try {
    if (value.length > 100) throw new Error();
    const locale = Intl.getCanonicalLocales(value)[0];
    if (!locale || locale === "und") throw new Error();
    return locale;
  } catch { throw new PushPortError("invalid_locale", "Use a valid BCP-47 locale, for example de-DE"); }
}

export function locales(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    try { const tag = normalizeLocale(value); if (!result.includes(tag)) result.push(tag); } catch { /* Invalid browser locale. */ }
  }
  return result.slice(0, 30).length ? result.slice(0, 30) : ["en"];
}

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new PushPortError("invalid_vapid_key", "Invalid Web Push public key");
  let bytes: Uint8Array<ArrayBuffer>;
  try { bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); }
  catch { throw new PushPortError("invalid_vapid_key", "Invalid Web Push public key"); }
  if (bytes.length !== 65 || bytes[0] !== 4) throw new PushPortError("invalid_vapid_key", "Expected an uncompressed P-256 public key");
  return bytes;
}

export function serializeSubscription(subscription: PushSubscription): WebSubscription {
  const p256dh = subscription.getKey("p256dh");
  const auth = subscription.getKey("auth");
  if (!p256dh || !auth) throw new PushPortError("invalid_subscription", "Browser returned an incomplete push subscription");
  return { endpoint: subscription.endpoint, expirationTime: subscription.expirationTime,
    keys: { p256dh: base64url(new Uint8Array(p256dh)), auth: base64url(new Uint8Array(auth)) } };
}

/** Notification clicks stay on the registered website; reject javascript/data/external URLs. */
export function clickTarget(value: unknown, origin: string): string {
  try {
    const url = new URL(typeof value === "string" ? value : "/", origin);
    if (url.origin === origin && ["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Use the safe root fallback. */ }
  return new URL("/", origin).href;
}
