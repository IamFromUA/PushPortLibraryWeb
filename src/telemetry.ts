import { updateState, readState } from "./storage.js";
import { request } from "./transport.js";
import { PushPortError, type StoredState, type NotificationEvent } from "./types.js";

export const collectionAllowed = (state: StoredState): boolean => !state.consentRequired || state.consentGiven === true;
export function appendEvent(state: StoredState, type: string, messageId?: string, details: Partial<NotificationEvent> = {}): void {
  if (!collectionAllowed(state)) return;
  const queue = state.telemetryEvents ??= [];
  queue.push({ ...details, id: crypto.randomUUID(), type, occurredAt: Date.now(), ...(messageId ? { messageId } : {}) });
  if (queue.length > 1000) { state.droppedEvents = (state.droppedEvents ?? 0) + queue.length - 1000; queue.splice(0, queue.length - 1000); }
}
export async function record(type: string, messageId?: string, details: Partial<NotificationEvent> = {}): Promise<void> {
  await updateState(state => { if (!state) throw new PushPortError("not_initialized", "Initialize PushPort first"); appendEvent(state, type, messageId, details); return state; });
}
export async function flushTelemetry(): Promise<void> {
  // Stable event IDs make concurrent page/worker uploads and retries harmless.
  for (let batch = 0; batch < 10; batch++) {
    const state = await readState();
    if (!state || !collectionAllowed(state) || !state.telemetryVersion || !state.telemetryEvents?.length) return;
    const events = state.telemetryEvents.slice(0, 100);
    let result: unknown;
    try { result = await request(state, `/installations/${state.installationId}/telemetry`, "POST", { events, dropped: state.droppedEvents ?? 0 }, state.secret); }
    catch (error) {
      if (error instanceof PushPortError && [404, 405].includes(error.httpStatus ?? 0)) {
        await updateState(latest => { if (!latest) throw error; latest.telemetryVersion = 0; return latest; }); return;
      }
      throw error;
    }
    const ids = (result as { acceptedIds?: unknown })?.acceptedIds;
    if (!Array.isArray(ids)) throw new PushPortError("invalid_response", "Invalid diagnostics acknowledgement");
    const sent = new Set(events.map(event => event.id));
    const accepted = new Set(ids.filter(id => typeof id === "string" && sent.has(id)));
    if (!accepted.size) return;
    await updateState(latest => { if (!latest) throw new PushPortError("storage_cleared", "Browser storage was cleared"); latest.telemetryEvents = (latest.telemetryEvents ?? []).filter(event => !accepted.has(event.id)); return latest; });
  }
}
