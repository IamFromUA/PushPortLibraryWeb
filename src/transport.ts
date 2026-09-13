import { PushPortError, type StoredState } from "./types.js";
import { readState, updateState } from "./storage.js";

export async function request(state: Pick<StoredState, "serverUrl" | "appId">, path: string,
  method = "GET", body?: unknown, secret?: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${state.serverUrl}/api/v1/sdk/apps/${state.appId}/platforms/web${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) throw new PushPortError(`http_${response.status}`, `PushPort request failed (${response.status})`, response.status);
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) { await reader.cancel(); throw new PushPortError("invalid_response", "PushPort response exceeded the size limit"); }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder().decode(bytes);
    try { return text ? JSON.parse(text) as unknown : null; }
    catch { throw new PushPortError("invalid_response", "PushPort returned invalid JSON"); }
  } catch (error) {
    if (error instanceof PushPortError) throw error;
    throw new PushPortError("network_error", "PushPort is unreachable; state will retry on the next sync");
  } finally { clearTimeout(timer); }
}

/** Idempotent opened events remain durable until acknowledged. */
export async function flushEvents(): Promise<void> {
  const state = await readState();
  if (!state) return;
  for (const messageId of state.pendingEvents) {
    try { await request(state, `/installations/${state.installationId}/events`, "POST", { messageId, type: "opened" }, state.secret); }
    catch (error) {
      // 404 means a removed message. A missing installation is recovered by the next registration.
      if (!(error instanceof PushPortError) || error.httpStatus !== 404) throw error;
    }
    await updateState(latest => {
      if (!latest) throw new PushPortError("not_initialized", "PushPort state was cleared");
      latest.pendingEvents = latest.pendingEvents.filter(id => id !== messageId); return latest;
    });
  }
}
