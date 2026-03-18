export async function listenServer(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server_address_unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}

export async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function jsonRequest(baseUrl, pathname, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  const init = { method, headers };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  let body = null;
  if (text) {
    body = JSON.parse(text);
  }

  return {
    status: response.status,
    headers: response.headers,
    body
  };
}

export async function waitFor(fn, { timeoutMs = 4000, intervalMs = 50 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() - started >= timeoutMs) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
