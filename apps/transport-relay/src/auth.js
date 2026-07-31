// Relay authentication (A-02).
//
// Two credential kinds, both bearer tokens:
//
//   admin token    — a shared secret from the deployment env. Full access:
//                    send to any receiver, read/ack any inbox, mint receiver
//                    tokens. Held by platform-api and operator tooling.
//   receiver token — HMAC-signed and scoped to exactly one receiver. A Provider
//                    device gets one for its own inbox and can read nothing
//                    else.
//
// Receiver tokens are self-contained so the relay needs no token storage and
// stays restart-safe: rotating RELAY_TOKEN_SECRET invalidates every issued
// token at once, which is the intended revocation mechanism for this stage.

import crypto from "node:crypto";

const RECEIVER_TOKEN_PREFIX = "rrt_";

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

// Timing-safe comparison that does not leak length through early return.
function secretEquals(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

/**
 * Mint a receiver-scoped token.
 *
 * @param {object} options
 * @param {string} options.receiver     inbox this token may access
 * @param {string} options.tokenSecret  HMAC secret
 * @param {number} [options.ttlSeconds] expiry; omit or 0 for a non-expiring token
 * @param {number} [options.now]        epoch millis, for deterministic tests
 */
export function issueReceiverToken({ receiver, tokenSecret, ttlSeconds = 0, now = Date.now() }) {
  if (!receiver) {
    throw new Error("receiver_required");
  }
  if (!tokenSecret) {
    throw new Error("token_secret_required");
  }
  const issuedAt = Math.floor(now / 1000);
  const claims = {
    r: receiver,
    iat: issuedAt,
    exp: ttlSeconds > 0 ? issuedAt + Number(ttlSeconds) : null
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  return {
    token: `${RECEIVER_TOKEN_PREFIX}${payload}.${sign(payload, tokenSecret)}`,
    receiver,
    issued_at: new Date(issuedAt * 1000).toISOString(),
    expires_at: claims.exp ? new Date(claims.exp * 1000).toISOString() : null
  };
}

function parseReceiverToken(token, tokenSecret, now = Date.now()) {
  if (!tokenSecret || typeof token !== "string" || !token.startsWith(RECEIVER_TOKEN_PREFIX)) {
    return null;
  }
  const body = token.slice(RECEIVER_TOKEN_PREFIX.length);
  const separator = body.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const payload = body.slice(0, separator);
  const signature = body.slice(separator + 1);
  if (!secretEquals(signature, sign(payload, tokenSecret))) {
    return null;
  }
  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }
  if (!claims || typeof claims.r !== "string") {
    return null;
  }
  if (claims.exp && now >= claims.exp * 1000) {
    return { expired: true };
  }
  return { kind: "receiver", receiver: claims.r };
}

function bearerToken(req) {
  const header = req.headers?.authorization;
  if (typeof header !== "string") {
    return null;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Build the relay's auth policy.
 *
 * `requireAuth` defaults to true whenever any credential is configured, so a
 * deployment that sets a secret cannot accidentally keep serving anonymous
 * traffic. With no credential at all the relay runs open — acceptable for
 * in-process and test use, and refused by the direct-run entrypoint.
 */
export function createRelayAuth({ adminToken = null, tokenSecret = null, requireAuth } = {}) {
  const enforced = requireAuth === undefined ? Boolean(adminToken || tokenSecret) : Boolean(requireAuth);

  return {
    get enforced() {
      return enforced;
    },
    get canMintTokens() {
      return Boolean(tokenSecret);
    },
    issue(receiver, ttlSeconds, now) {
      return issueReceiverToken({ receiver, tokenSecret, ttlSeconds, now });
    },
    /**
     * Resolve a request's identity.
     * @returns {{kind: "anonymous"|"admin"|"receiver", receiver?: string}|{error: string}}
     */
    resolve(req, now = Date.now()) {
      if (!enforced) {
        return { kind: "anonymous" };
      }
      const token = bearerToken(req);
      if (!token) {
        return { error: "missing" };
      }
      if (adminToken && secretEquals(token, adminToken)) {
        return { kind: "admin" };
      }
      const parsed = parseReceiverToken(token, tokenSecret, now);
      if (parsed?.expired) {
        return { error: "expired" };
      }
      if (parsed) {
        return parsed;
      }
      return { error: "invalid" };
    },
    /**
     * May this identity touch this receiver's inbox? Admin may touch any;
     * a receiver token may touch only its own.
     */
    allowsReceiver(identity, receiver) {
      if (!enforced || identity.kind === "anonymous" || identity.kind === "admin") {
        return true;
      }
      return identity.kind === "receiver" && identity.receiver === receiver;
    },
    isAdmin(identity) {
      return !enforced || identity.kind === "admin" || identity.kind === "anonymous";
    }
  };
}
