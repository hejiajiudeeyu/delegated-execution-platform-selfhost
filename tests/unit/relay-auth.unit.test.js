import { describe, expect, it } from "vitest";

import { createRelayAuth, issueReceiverToken } from "../../apps/transport-relay/src/auth.js";

const SECRET = "relay-token-secret-for-tests";
const ADMIN = "relay-admin-token-for-tests";

function requestWith(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

describe("relay auth", () => {
  it("stays open only when no credential is configured", () => {
    expect(createRelayAuth({}).enforced).toBe(false);
    expect(createRelayAuth({ adminToken: ADMIN }).enforced).toBe(true);
    expect(createRelayAuth({ tokenSecret: SECRET }).enforced).toBe(true);
    // an explicit override still wins, so a trusted network can opt out
    expect(createRelayAuth({ adminToken: ADMIN, requireAuth: false }).enforced).toBe(false);
  });

  it("accepts the admin token and rejects a wrong one", () => {
    const auth = createRelayAuth({ adminToken: ADMIN, tokenSecret: SECRET });
    expect(auth.resolve(requestWith(ADMIN))).toEqual({ kind: "admin" });
    expect(auth.resolve(requestWith("not-the-admin-token"))).toEqual({ error: "invalid" });
    expect(auth.resolve(requestWith(null))).toEqual({ error: "missing" });
  });

  it("scopes a receiver token to exactly one inbox", () => {
    const auth = createRelayAuth({ adminToken: ADMIN, tokenSecret: SECRET });
    const { token } = issueReceiverToken({ receiver: "responder_a", tokenSecret: SECRET });

    const identity = auth.resolve(requestWith(token));
    expect(identity).toEqual({ kind: "receiver", receiver: "responder_a" });
    expect(auth.allowsReceiver(identity, "responder_a")).toBe(true);
    expect(auth.allowsReceiver(identity, "responder_b")).toBe(false);
    // and it can never mint tokens or act as operator
    expect(auth.isAdmin(identity)).toBe(false);
  });

  it("rejects a token signed with a different secret", () => {
    const auth = createRelayAuth({ tokenSecret: SECRET });
    const { token } = issueReceiverToken({ receiver: "responder_a", tokenSecret: "some-other-secret" });
    expect(auth.resolve(requestWith(token))).toEqual({ error: "invalid" });
  });

  it("rejects a tampered receiver claim", () => {
    const auth = createRelayAuth({ tokenSecret: SECRET });
    const { token } = issueReceiverToken({ receiver: "responder_a", tokenSecret: SECRET });
    const [payload, signature] = token.slice("rrt_".length).split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ r: "responder_b", iat: 0, exp: null })).toString("base64url");

    expect(auth.resolve(requestWith(`rrt_${forgedPayload}.${signature}`))).toEqual({ error: "invalid" });
    expect(payload).not.toBe(forgedPayload);
  });

  it("reports an expired token distinctly from an invalid one", () => {
    const auth = createRelayAuth({ tokenSecret: SECRET });
    const issuedAt = Date.parse("2026-07-31T00:00:00.000Z");
    const { token, expires_at } = issueReceiverToken({
      receiver: "responder_a",
      tokenSecret: SECRET,
      ttlSeconds: 60,
      now: issuedAt
    });

    expect(auth.resolve(requestWith(token), issuedAt + 30_000)).toEqual({ kind: "receiver", receiver: "responder_a" });
    expect(auth.resolve(requestWith(token), issuedAt + 61_000)).toEqual({ error: "expired" });
    expect(expires_at).toBe("2026-07-31T00:01:00.000Z");
  });

  it("treats every identity as permitted while unenforced", () => {
    const auth = createRelayAuth({});
    const identity = auth.resolve(requestWith(null));
    expect(identity).toEqual({ kind: "anonymous" });
    expect(auth.allowsReceiver(identity, "anything")).toBe(true);
    expect(auth.isAdmin(identity)).toBe(true);
  });
});
