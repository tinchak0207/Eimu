const express = require("express");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 8082);
const DATA_DIR = process.env.DATA_DIR || "/data/files";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.IMAGE_DATA_API_KEY || "";
const MAX_BODY_BYTES = 100 * 1024 * 1024;

const pool = new Pool({
  host: process.env.PGHOST || "sub2api-vps-postgres",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "image_data",
  password: process.env.PGPASSWORD || "",
  database: process.env.PGDATABASE || "image_data",
  max: 10,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      pathname TEXT PRIMARY KEY,
      payload BYTEA NOT NULL,
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size BIGINT NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS routing_events (
      id BIGSERIAL PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safePath(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let p = raw.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!p || p.includes("\0") || p.length > 512) return null;
  const segments = p.split("/");
  if (segments.some((s) => s === ".." || s === "." || !s)) return null;
  return segments.join("/");
}

function fileUrl(pathname) {
  return `${PUBLIC_BASE}/files/${pathname}`;
}

function contentTypeFor(pathname) {
  const ext = path.extname(pathname).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".pdf": "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}

async function writeToDisk(pathname, buffer) {
  const fp = path.join(DATA_DIR, pathname);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, buffer);
}

function removeFromDisk(pathname) {
  const fp = path.join(DATA_DIR, pathname);
  try {
    fs.rmSync(fp, { force: true });
  } catch {
    // ignore
  }
}

app.use("/api", (req, res, next) => {
  if (!API_KEY || req.headers["x-image-data-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode}`);
  });
  next();
});

app.get("/", (req, res) => {
  res.json({ service: "image-data-api", ok: true });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/blob/list", async (req, res) => {
  try {
    const prefix = String(req.query.prefix || "");
    const cursor = String(req.query.cursor || "");
    const limit = Math.min(Number(req.query.limit) || 1000, 1000);
    const sql =
      "SELECT pathname, content_type, size, uploaded_at FROM kv_store " +
      "WHERE pathname LIKE $1 AND pathname > $2::text " +
      "ORDER BY pathname LIMIT $3::int";
    const params = [prefix + "%"];
    params.push(cursor);
    params.push(limit + 1);
    const { rows } = await pool.query(sql, params);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    res.json({
      blobs: page.map((r) => ({
        url: fileUrl(r.pathname),
        pathname: r.pathname,
        size: Number(r.size),
        uploadedAt: r.uploaded_at.toISOString(),
      })),
      cursor: hasMore ? page[page.length - 1].pathname : undefined,
      hasMore,
    });
  } catch (err) {
    console.error("list error", err);
    res.status(500).json({ error: "list failed" });
  }
});

app.get("/api/blob/get", async (req, res) => {
  try {
    const ref = String(req.query.path || req.query.url || "");
    let pathname = safePath(ref);
    if (!pathname && ref.includes("/files/")) {
      pathname = safePath(ref.split("/files/")[1]);
    }
    if (!pathname) return res.status(400).json({ error: "bad path" });
    const { rows } = await pool.query(
      "SELECT payload, content_type, size, uploaded_at FROM kv_store WHERE pathname=$1",
      [pathname],
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.set("Content-Type", rows[0].content_type || "application/octet-stream");
    res.set("X-Blob-Size", String(rows[0].size));
    res.set("X-Blob-Uploaded-At", new Date(rows[0].uploaded_at).toISOString());
    res.send(rows[0].payload);
  } catch (err) {
    console.error("get error", err);
    res.status(500).json({ error: "get failed" });
  }
});

app.put("/api/blob/:path(*)", async (req, res) => {
  try {
    const pathname = safePath(req.params.path);
    if (!pathname) return res.status(400).json({ error: "bad path" });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return res.status(413).json({ error: "too large" });
    }
    const buffer = Buffer.concat(chunks);
    const contentType = String(req.headers["x-content-type"] || "application/octet-stream");
    await pool.query(
      `INSERT INTO kv_store (pathname, payload, content_type, size, uploaded_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (pathname) DO UPDATE
       SET payload = EXCLUDED.payload,
           content_type = EXCLUDED.content_type,
           size = EXCLUDED.size,
           uploaded_at = now()`,
      [pathname, buffer, contentType, buffer.length],
    );
    if (contentType.startsWith("image/") || buffer.length > 32768) {
      writeToDisk(pathname, buffer);
    }
    res.json({
      url: fileUrl(pathname),
      pathname,
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("put error", err);
    res.status(500).json({ error: "put failed" });
  }
});

app.delete("/api/blob/:path(*)", async (req, res) => {
  try {
    const pathname = safePath(req.params.path);
    if (!pathname) return res.status(400).json({ error: "bad path" });
    await pool.query("DELETE FROM kv_store WHERE pathname=$1", [pathname]);
    removeFromDisk(pathname);
    res.json({ deleted: 1 });
  } catch (err) {
    console.error("del error", err);
    res.status(500).json({ error: "del failed" });
  }
});

app.get("/files/:path(*)", async (req, res) => {
  try {
    const pathname = safePath(req.params.path);
    if (!pathname) return res.status(400).send("bad path");
    const fp = path.join(DATA_DIR, pathname);
    if (fs.existsSync(fp)) {
      res.set("Content-Type", contentTypeFor(pathname));
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(fp);
    }
    const { rows } = await pool.query(
      "SELECT payload, content_type FROM kv_store WHERE pathname=$1",
      [pathname],
    );
    if (!rows.length) return res.status(404).send("not found");
    res.set("Content-Type", rows[0].content_type || contentTypeFor(pathname));
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.send(rows[0].payload);
  } catch (err) {
    console.error("file error", err);
    res.status(500).send("file error");
  }
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`image-data-api listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error("init failed", err);
    process.exit(1);
  });
