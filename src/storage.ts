import { base64url } from "./validation.js";
import { PushPortError, type StoredState } from "./types.js";

const DATABASE = "pushport-web-v1";
const STORE = "state";
const KEY = "installation";

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new PushPortError("storage_unavailable", "Persistent browser storage is unavailable"));
    request.onblocked = () => reject(new PushPortError("storage_blocked", "Close other tabs using an older SDK and retry"));
  });
}

/** Read-modify-write happens in one IndexedDB transaction, including across tabs/worker. */
export async function updateState(change: (state: StoredState | null) => StoredState): Promise<StoredState> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    let result: StoredState;
    let failure: unknown;
    const request = store.get(KEY);
    request.onsuccess = () => {
      try { result = change((request.result as StoredState | undefined) ?? null); store.put(result, KEY); }
      catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => { db.close(); resolve(result); };
    transaction.onabort = transaction.onerror = () => {
      db.close(); reject(failure ?? new PushPortError("storage_unavailable", "Could not persist PushPort state"));
    };
  });
}

export async function readState(): Promise<StoredState | null> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(KEY);
    transaction.oncomplete = () => { db.close(); resolve((request.result as StoredState | undefined) ?? null); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(new PushPortError("storage_unavailable", "Could not read PushPort state")); };
  });
}

export function bind(appId: string, serverUrl: string, origin: string): Promise<StoredState> {
  return updateState(previous => {
    if (previous) {
      if (previous.schema !== 1 || previous.appId !== appId || previous.serverUrl !== serverUrl || previous.origin !== origin) {
        throw new PushPortError("configuration_conflict", "This origin is already bound to another PushPort application/server");
      }
      return previous;
    }
    return { schema: 1, appId, serverUrl, origin, vapidPublicKey: null, installationId: crypto.randomUUID(),
      secret: base64url(crypto.getRandomValues(new Uint8Array(32))), subscribed: true,
      localeOverride: null, revision: 0, snapshot: null, pendingEvents: [], lastSyncedAt: null, syncError: null };
  });
}

export async function queueOpened(appId: string, messageId: string): Promise<void> {
  await updateState(state => {
    if (!state || state.appId !== appId) throw new PushPortError("not_initialized", "PushPort is not initialized for this application");
    if (!state.pendingEvents.includes(messageId)) state.pendingEvents = [...state.pendingEvents, messageId].slice(-100);
    return state;
  });
}
