async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function main() {
  const baseUrl = process.env.PLATFORM_BASE_URL || "http://127.0.0.1:8080";

  const health = await jsonRequest(baseUrl, "/healthz");
  if (health.status !== 200 || health.body?.ok !== true) {
    throw new Error(`platform_health_failed: ${health.status}`);
  }

  const register = await jsonRequest(baseUrl, "/v1/users/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contact_email: `platform-smoke-${Date.now()}@test.local`
    })
  });
  if (register.status !== 201 || !register.body?.api_key) {
    throw new Error(`platform_register_failed: ${register.status}`);
  }

  const catalog = await jsonRequest(baseUrl, "/v2/hotlines?status=enabled");
  if (catalog.status !== 200 || !Array.isArray(catalog.body?.items)) {
    throw new Error(`platform_catalog_failed: ${catalog.status}`);
  }

  console.log(`[platform-smoke] ok baseUrl=${baseUrl} catalog_items=${catalog.body.items.length}`);
}

main().catch((error) => {
  console.error(`[platform-smoke] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
