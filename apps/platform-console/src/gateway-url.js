// Gateway URL resolution for the served console.
//
// The console is deployed behind an edge that maps:
//   /console/*  -> gateway static assets
//   /gateway/*  -> gateway API (path-stripped)
// (see deploy/public-stack/Caddyfile; nginx deployments mirror it).
//
// Joining API paths onto that base with `new URL("/session/...", base)`
// silently drops the `/gateway` prefix because a leading slash resolves
// against the origin, and a base without a trailing slash drops its last
// segment even for relative paths. These helpers make the join explicit so
// the console works identically on direct gateway origins (port 8085) and
// behind subpath edges.

export function resolveGatewayBase(location, defaultUrl = "http://127.0.0.1:8085") {
  if (location && location.port === "8085") {
    return `${location.origin}/`;
  }
  if (location && typeof location.pathname === "string" && location.pathname.startsWith("/console")) {
    return `${location.origin}/gateway/`;
  }
  return defaultUrl.endsWith("/") ? defaultUrl : `${defaultUrl}/`;
}

export function gatewayApiUrl(base, pathname) {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const relativePath = String(pathname || "").replace(/^\/+/, "");
  return new URL(relativePath, normalizedBase);
}
