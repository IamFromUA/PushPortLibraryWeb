import { readState } from "./storage.js";
import { collectionAllowed, PushPortError } from "./types.js";

export async function ensureSubscription(registration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription | null> {
  const existing = await registration.pushManager.getSubscription();
  const before = await readState();
  if (!before?.subscribed || !collectionAllowed(before)) return null;
  if (existing) {
    const used = existing.options.applicationServerKey;
    if (used && (used.byteLength !== key.length || new Uint8Array(used).some((byte, i) => byte !== key[i]))) {
      throw new PushPortError("vapid_key_conflict", "An existing subscription uses another VAPID key; migrate it explicitly before subscribing");
    }
    return existing;
  }
  const created = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const after = await readState();
  if (after?.installationId === before.installationId && after.subscribed && collectionAllowed(after)) return created;
  // Consent or opt-in changed while the browser was contacting its push provider.
  await created.unsubscribe();
  return null;
}
