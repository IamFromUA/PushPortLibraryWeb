import { readState, updateState } from "./storage.js";
import { request } from "./transport.js";
import { collectionAllowed } from "./telemetry.js";
import { PushPortError, type PushPortUser, type UserOperation } from "./types.js";

export function validatePatch(values: Record<string, string | null>, maximum = 50): void {
  if (Object.keys(values).length > maximum || Object.entries(values).some(([key, value]) => !key.trim() || key.length > 64 || /[\x00-\x1f\x7f]/.test(key) || (value !== null && (typeof value !== "string" || value.length > 256)))) {
    throw new PushPortError("invalid_tags", "Use at most 50 tags with keys up to 64 and values up to 256 characters");
  }
}
export async function enqueueUser(operation: Omit<UserOperation, "revision">): Promise<void> {
  await updateState(state => {
    if (!state || !collectionAllowed(state)) throw new PushPortError("consent_required", "Initialize PushPort and provide consent first");
    const switching = ["login", "logout"].includes(operation.kind);
    const pending = switching ? [] : state.userOperations ?? [];
    if (pending.length >= 100) throw new PushPortError("queue_full", "Wait for pending user changes to synchronize");
    const revision = Math.max(state.userRevision ?? 0, state.user?.revision ?? 0) + 1;
    state.userRevision = revision; state.userOperations = [...pending, { ...operation, revision }];
    if (switching) state.user = null;
    return state;
  });
}
export async function flushUsers(): Promise<PushPortUser | null> {
  let state = await readState();
  if (!state || !collectionAllowed(state) || !state.userProfileVersion) return state?.user ?? null;
  for (let count = 0; count < 100; count++) {
    state = await readState(); if (!state || !collectionAllowed(state)) return null;
    const operation = state.userOperations?.[0]; if (!operation) break;
    const profile = await request(state, `/installations/${state.installationId}/user`, "PUT", operation, state.secret) as PushPortUser;
    if (!profile || typeof profile.userId !== "string" || !profile.properties) throw new PushPortError("invalid_response", "Invalid user profile");
    await updateState(latest => { if (!latest) throw new PushPortError("storage_cleared", "Browser storage was cleared"); latest.userOperations = (latest.userOperations ?? []).filter(item => item.revision !== operation.revision); if (!latest.userOperations.some(item => ["login", "logout"].includes(item.kind))) latest.user = profile; return latest; });
  }
  state = await readState(); if (!state) return null;
  if (!state.user) {
    const profile = await request(state, `/installations/${state.installationId}/user`, "GET", undefined, state.secret) as PushPortUser;
    if (!profile?.properties || typeof profile.userId !== "string") throw new PushPortError("invalid_response", "Invalid user profile");
    await updateState(latest => { if (!latest) throw new PushPortError("storage_cleared", "Browser storage was cleared"); if (!latest.userOperations?.length) latest.user = profile; return latest; });
  }
  return (await readState())?.user ?? null;
}
