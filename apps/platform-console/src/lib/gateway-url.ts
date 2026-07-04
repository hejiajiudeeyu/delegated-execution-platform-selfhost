// Gateway URL resolution for the served console (subpath-safe).
// Edge contract: /console/* -> static assets, /gateway/* -> gateway API
// (both path-stripped; see deploy/public-stack/Caddyfile).

export interface LocationLike {
  origin: string;
  pathname: string;
  port: string;
}

export function resolveGatewayBase(location: LocationLike, defaultUrl = "http://127.0.0.1:8085"): string {
  if (location && location.port === "8085") {
    return `${location.origin}/`;
  }
  if (location && typeof location.pathname === "string" && location.pathname.startsWith("/console")) {
    return `${location.origin}/gateway/`;
  }
  return defaultUrl.endsWith("/") ? defaultUrl : `${defaultUrl}/`;
}

export function gatewayApiUrl(base: string, pathname: string): URL {
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  const relativePath = String(pathname || "").replace(/^\/+/, "");
  return new URL(relativePath, normalizedBase);
}
