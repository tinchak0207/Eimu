const base = "http://localhost:8082";
const key = process.env.IMAGE_DATA_API_KEY;

async function run() {
  const health = await fetch(`${base}/api/health`);
  console.log("health", health.status, await health.text());

  const bad = await fetch(`${base}/api/blob/get?path=x`, {
    headers: { "x-image-data-key": "wrong" },
  });
  console.log("auth-bad", bad.status);

  const put = await fetch(`${base}/api/blob/test-kv-1`, {
    method: "PUT",
    headers: {
      "x-image-data-key": key,
      "Content-Type": "application/octet-stream",
      "x-content-type": "application/json",
    },
    body: JSON.stringify({ ok: true }),
  });
  console.log("put", put.status, await put.text());

  const get = await fetch(`${base}/api/blob/get?path=test-kv-1`, {
    headers: { "x-image-data-key": key },
  });
  console.log("get", get.status, await get.text());

  const list = await fetch(`${base}/api/blob/list?prefix=test-`, {
    headers: { "x-image-data-key": key },
  });
  console.log("list", list.status, await list.text());

  const del = await fetch(`${base}/api/blob/test-kv-1`, {
    method: "DELETE",
    headers: { "x-image-data-key": key },
  });
  console.log("del", del.status, await del.text());
}

run().catch((err) => {
  console.error("SMOKE_FAIL", err);
  process.exit(1);
});
