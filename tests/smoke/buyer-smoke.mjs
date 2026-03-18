async function jsonRequest(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function main() {
  const baseUrl = process.env.BUYER_BASE_URL || "http://127.0.0.1:8081";

  const health = await jsonRequest(baseUrl, "/healthz");
  if (health.status !== 200 || health.body?.ok !== true) {
    throw new Error(`buyer_health_failed: ${health.status}`);
  }

  const root = await jsonRequest(baseUrl, "/");
  if (root.status !== 200 || root.body?.status !== "running") {
    throw new Error(`buyer_root_failed: ${root.status}`);
  }

  console.log(`[buyer-smoke] ok baseUrl=${baseUrl}`);
}

main().catch((error) => {
  console.error(`[buyer-smoke] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
