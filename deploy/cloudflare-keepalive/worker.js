export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runKeepAlive(env));
  },

  async fetch(_request, env, ctx) {
    ctx.waitUntil(runKeepAlive(env));
    return new Response("keepalive worker ok", { status: 200 });
  },
};

async function runKeepAlive(env) {
  const target = env.RENDER_HEALTHCHECK_URL;

  if (!target) {
    console.error("Missing RENDER_HEALTHCHECK_URL");
    return;
  }

  const response = await fetch(target, {
    method: "GET",
    headers: {
      "User-Agent": "cloudflare-worker-keepalive",
      Accept: "application/json,text/plain,*/*",
    },
    cf: {
      cacheTtl: 0,
      cacheEverything: false,
    },
  });

  const text = await response.text();
  console.log(
    JSON.stringify({
      ok: response.ok,
      status: response.status,
      target,
      bodyPreview: text.slice(0, 160),
    }),
  );
}
