// Hydration must not silently discard the operator's configured admin key.
//
// Found during the E7 restore rehearsal (2026-08-06): a stack restored from a
// real production backup answered 401 to the admin key in the .env it was
// started with, because hydration replaces the whole apiKeys map with the
// snapshot's copy. The same mechanism made PLATFORM_ADMIN_API_KEY rotation a
// no-op on any stack that already had persisted state — the service restarted
// clean and the previous key kept working.
import { afterEach, describe, expect, it } from "vitest";

import {
  createPlatformServer,
  createPlatformState,
  hydratePlatformState,
  serializePlatformState
} from "@delexec/platform-api";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

function adminEntries(state) {
  return Array.from(state.apiKeys.entries()).filter(([, value]) => value?.type === "admin");
}

// A snapshot as a restored database would supply it: taken from a stack whose
// admin key was something else entirely.
function snapshotWithAdminKey(adminApiKey) {
  const source = createPlatformState({ adminApiKey, tokenSecret: "snapshot-secret" });
  return serializePlatformState(source);
}

describe("platform state hydration and the configured admin key", () => {
  const cleanup = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()();
    }
  });

  it("keeps the configured admin key working after restoring someone else's snapshot", () => {
    const snapshot = snapshotWithAdminKey("sk_admin_from_the_backup");
    const state = createPlatformState({ adminApiKey: "sk_admin_operator_holds", tokenSecret: "t" });

    hydratePlatformState(state, snapshot);

    expect(state.apiKeys.get("sk_admin_operator_holds")).toMatchObject({ type: "admin" });
  });

  it("revokes the previous admin key so rotation actually rotates", () => {
    const snapshot = snapshotWithAdminKey("sk_admin_old");
    const state = createPlatformState({ adminApiKey: "sk_admin_new", tokenSecret: "t" });

    hydratePlatformState(state, snapshot);

    expect(state.apiKeys.has("sk_admin_old")).toBe(false);
    expect(adminEntries(state)).toHaveLength(1);
  });

  it("leaves the snapshot's admin key alone when no key was configured", () => {
    // The fallback is random per boot. Treating it as configuration would
    // revoke the operator's working key on every restart.
    //
    // platform-api loads a local env file when one is present, so this case
    // has to state the absence rather than assume it.
    const previous = process.env.PLATFORM_ADMIN_API_KEY;
    delete process.env.PLATFORM_ADMIN_API_KEY;
    try {
      const snapshot = snapshotWithAdminKey("sk_admin_persisted");
      const state = createPlatformState({ tokenSecret: "t" });
      const generated = state.adminApiKey;

      hydratePlatformState(state, snapshot);

      expect(state.apiKeys.has("sk_admin_persisted")).toBe(true);
      expect(state.apiKeys.has(generated)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.PLATFORM_ADMIN_API_KEY;
      } else {
        process.env.PLATFORM_ADMIN_API_KEY = previous;
      }
    }
  });

  it("does not disturb the rest of the restored state", () => {
    const source = createPlatformState({ adminApiKey: "sk_admin_from_the_backup", tokenSecret: "s" });
    source.users.set("usr_restored", { user_id: "usr_restored", roles: ["caller"] });
    source.apiKeys.set("sk_caller_restored", { type: "caller", user_id: "usr_restored" });
    const snapshot = serializePlatformState(source);

    const state = createPlatformState({ adminApiKey: "sk_admin_operator_holds", tokenSecret: "t" });
    hydratePlatformState(state, snapshot);

    expect(state.users.get("usr_restored")).toMatchObject({ user_id: "usr_restored" });
    expect(state.apiKeys.get("sk_caller_restored")).toMatchObject({ type: "caller" });
  });

  it("authenticates an admin request with the configured key over HTTP", async () => {
    const snapshot = snapshotWithAdminKey("sk_admin_from_the_backup");
    const state = createPlatformState({ adminApiKey: "sk_admin_operator_holds", tokenSecret: "t" });
    hydratePlatformState(state, snapshot);

    const server = createPlatformServer({ state, serviceName: "platform-hydration-test" });
    const baseUrl = await listenServer(server);
    cleanup.push(() => closeServer(server));

    const accepted = await jsonRequest(baseUrl, "/v1/admin/attention", {
      headers: { authorization: "Bearer sk_admin_operator_holds" }
    });
    expect(accepted.status).toBe(200);

    const refused = await jsonRequest(baseUrl, "/v1/admin/attention", {
      headers: { authorization: "Bearer sk_admin_from_the_backup" }
    });
    expect(refused.status).toBe(401);
  });
});
