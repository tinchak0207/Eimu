const express = require("express");
const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { once } = require("events");

const app = express();
const PORT = Number(process.env.PORT || 8082);
const DATA_DIR = process.env.DATA_DIR || "/data/files";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.IMAGE_DATA_API_KEY || "";
const MAX_BODY_BYTES = 100 * 1024 * 1024;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const REDACT_QUERY = new Set(["ticket", "token", "signature", "expires"]);

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
      content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size BIGINT NOT NULL,
      sha TEXT,
      disk_path TEXT,
      pinned BOOLEAN NOT NULL DEFAULT false,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS routing_events (
      id BIGSERIAL PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query("ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS sha TEXT");
  await pool.query("ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS disk_path TEXT");
  await pool.query(
    "ALTER TABLE kv_store ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT false",
  );
  const payload = await pool.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'kv_store' AND column_name = 'payload'`,
  );
  if (payload.rows[0] && payload.rows[0].is_nullable === "NO") {
    await pool.query("ALTER TABLE kv_store ALTER COLUMN payload DROP NOT NULL");
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, ".incoming"), { recursive: true });
}

function safePath(raw) {
  if (typeof raw !== "string" || !raw) return null;
  let p = raw.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!p || p.includes("\0") || p.length > 512) return null;
  const segments = p.split("/");
  if (segments.some((s) => s === ".." || s === "." || !s)) return null;
  return segments.join("/");
}

function diskFile(rel) {
  const clean = safePath(rel);
  if (!clean) return null;
  const root = path.resolve(DATA_DIR);
  const fp = path.resolve(root, clean);
  if (fp !== root && !fp.startsWith(root + path.sep)) return null;
  return fp;
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

function requestPathForLog(req) {
  const raw = req.originalUrl || req.url || "";
  const q = raw.indexOf("?");
  if (q < 0) return raw;
  const params = new URLSearchParams(raw.slice(q + 1));
  for (const key of [...params.keys()]) {
    if (REDACT_QUERY.has(key.toLowerCase())) params.set(key, "[redacted]");
  }
  const search = params.toString();
  return search ? `${raw.slice(0, q)}?${search}` : raw.slice(0, q);
}

function removeFromDisk(pathname) {
  const fp = diskFile(pathname);
  if (!fp) return;
  try {
    fs.rmSync(fp, { force: true });
  } catch {
    // ignore
  }
}

async function spoolUpload(req, tmpPath) {
  const hash = crypto.createHash("sha256");
  let size = 0;
  const out = fs.createWriteStream(tmpPath);
  let failed = false;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error("too large");
        err.statusCode = 413;
        throw err;
      }
      hash.update(buf);
      if (!out.write(buf)) await once(out, "drain");
    }
    await new Promise((resolve, reject) => {
      out.end((err) => (err ? reject(err) : resolve()));
    });
    return { size, sha: hash.digest("hex") };
  } catch (err) {
    failed = true;
    out.destroy();
    req.destroy();
    throw err;
  } finally {
    if (failed) fs.rmSync(tmpPath, { force: true });
  }
}

async function sendDiskOrLegacy(res, pathname, meta, asJson) {
  const rel = meta?.disk_path || pathname;
  const fp = diskFile(rel);
  if (fp && fs.existsSync(fp)) {
    res.set("Content-Type", meta?.content_type || contentTypeFor(pathname));
    if (meta?.size != null) res.set("X-Blob-Size", String(meta.size));
    if (meta?.uploaded_at) res.set("X-Blob-Uploaded-At", new Date(meta.uploaded_at).toISOString());
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(fp);
  }
  const notFound = () => (asJson ? res.status(404).json({ error: "not found" }) : res.status(404).send("not found"));
  try {
    const legacy = await pool.query(
      "SELECT content_type, payload FROM kv_store WHERE pathname=$1 AND payload IS NOT NULL",
      [pathname],
    );
    if (!legacy.rows.length || legacy.rows[0].payload == null) return notFound();
    res.set("Content-Type", legacy.rows[0].content_type || contentTypeFor(pathname));
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return res.send(legacy.rows[0].payload);
  } catch (err) {
    if (err && err.code === "42703") return notFound();
    throw err;
  }
}

function olderThanTtl(mtimeMs) {
  return Date.now() - mtimeMs >= TTL_MS;
}

async function cleanupExpired() {
  const pinnedRows = await pool.query(
    "SELECT pathname, disk_path FROM kv_store WHERE pinned IS TRUE",
  );
  const pinned = new Set();
  for (const row of pinnedRows.rows) {
    if (row.pathname) pinned.add(row.pathname);
    if (row.disk_path) pinned.add(row.disk_path);
  }

  const stack = [DATA_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === ".incoming" || ent.name.startsWith(".")) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || !olderThanTtl(st.mtimeMs)) continue;
      const rel = path.relative(DATA_DIR, abs).split(path.sep).join("/");
      if (!rel || pinned.has(rel)) continue;
      try {
        const again = fs.lstatSync(abs);
        if (!again.isFile() || !olderThanTtl(again.mtimeMs)) continue;
        fs.rmSync(abs, { force: true });
      } catch {
        continue;
      }
      await pool.query(
        "DELETE FROM kv_store WHERE pinned IS NOT TRUE AND (pathname = $1 OR disk_path = $1)",
        [rel],
      );
    }
  }

  const incoming = path.join(DATA_DIR, ".incoming");
  let temps;
  try {
    temps = fs.readdirSync(incoming);
  } catch {
    temps = [];
  }
  for (const name of temps) {
    const abs = path.join(incoming, name);
    try {
      const st = fs.lstatSync(abs);
      if (!st.isFile() || !olderThanTtl(st.mtimeMs)) continue;
      fs.rmSync(abs, { force: true });
    } catch {
      // ignore
    }
  }
}

function startCleanupTimer() {
  if (process.env.IMAGE_DATA_CLEANUP === "0") return;
  const run = () => {
    cleanupExpired().catch((err) => {
      console.error("cleanup error", err && err.message ? err.message : "failed");
    });
  };
  const first = setTimeout(run, 30_000);
  first.unref();
  const timer = setInterval(run, CLEANUP_INTERVAL_MS);
  timer.unref();
}

app.use("/api", (req, res, next) => {
  if (!API_KEY || req.headers["x-image-data-key"] !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.use((req, res, next) => {
  res.on("finish", () => {
    console.log(`${req.method} ${requestPathForLog(req)} -> ${res.statusCode}`);
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
    console.error("list error", err && err.message ? err.message : "failed");
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
      "SELECT content_type, size, sha, disk_path, uploaded_at FROM kv_store WHERE pathname=$1",
      [pathname],
    );
    if (!rows.length) return res.status(404).json({ error: "not found" });
    return sendDiskOrLegacy(res, pathname, rows[0], true);
  } catch (err) {
    console.error("get error", err && err.message ? err.message : "failed");
    res.status(500).json({ error: "get failed" });
  }
});

app.put("/api/blob/:path(*)", async (req, res) => {
  const pathname = safePath(req.params.path);
  if (!pathname) return res.status(400).json({ error: "bad path" });
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "too large" });
  }
  const tmp = path.join(
    DATA_DIR,
    ".incoming",
    `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`,
  );
  try {
    const { size, sha } = await spoolUpload(req, tmp);
    const fp = diskFile(pathname);
    if (!fp) {
      fs.rmSync(tmp, { force: true });
      return res.status(400).json({ error: "bad path" });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.renameSync(tmp, fp);
    const contentType = String(req.headers["x-content-type"] || "application/octet-stream").slice(0, 200);
    await pool.query(
      `INSERT INTO kv_store (pathname, content_type, size, sha, disk_path, uploaded_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (pathname) DO UPDATE
       SET content_type = EXCLUDED.content_type,
           size = EXCLUDED.size,
           sha = EXCLUDED.sha,
           disk_path = EXCLUDED.disk_path,
           uploaded_at = now()`,
      [pathname, contentType, size, sha, pathname],
    );
    res.json({
      url: fileUrl(pathname),
      pathname,
      size,
      sha,
      uploadedAt: new Date().toISOString(),
    });
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    if (err && err.statusCode === 413) {
      if (!res.headersSent) return res.status(413).json({ error: "too large" });
      return;
    }
    console.error("put error", err && err.message ? err.message : "failed");
    if (!res.headersSent) res.status(500).json({ error: "put failed" });
  }
});

app.delete("/api/blob/:path(*)", async (req, res) => {
  try {
    const pathname = safePath(req.params.path);
    if (!pathname) return res.status(400).json({ error: "bad path" });
    const existing = await pool.query(
      "SELECT disk_path FROM kv_store WHERE pathname=$1",
      [pathname],
    );
    await pool.query("DELETE FROM kv_store WHERE pathname=$1", [pathname]);
    removeFromDisk(pathname);
    if (existing.rows[0]?.disk_path && existing.rows[0].disk_path !== pathname) {
      removeFromDisk(existing.rows[0].disk_path);
    }
    res.json({ deleted: 1 });
  } catch (err) {
    console.error("del error", err && err.message ? err.message : "failed");
    res.status(500).json({ error: "del failed" });
  }
});

app.get("/files/:path(*)", async (req, res) => {
  try {
    const pathname = safePath(req.params.path);
    if (!pathname) return res.status(400).send("bad path");
    const { rows } = await pool.query(
      "SELECT content_type, size, disk_path, uploaded_at FROM kv_store WHERE pathname=$1",
      [pathname],
    );
    const direct = diskFile(pathname);
    if (!rows.length && direct && fs.existsSync(direct)) {
      res.set("Content-Type", contentTypeFor(pathname));
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      return res.sendFile(direct);
    }
    if (!rows.length && !(direct && fs.existsSync(direct))) {
      return res.status(404).send("not found");
    }
    return sendDiskOrLegacy(res, pathname, rows[0] || null);
  } catch (err) {
    console.error("file error", err && err.message ? err.message : "failed");
    if (!res.headersSent) res.status(500).send("file error");
  }
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`image-data-api listening on :${PORT}`);
      startCleanupTimer();
    });
  })
  .catch((err) => {
    console.error("init failed", err && err.message ? err.message : "failed");
    process.exit(1);
  });
