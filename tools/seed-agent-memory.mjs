#!/usr/bin/env node
// Seed the shared agent-memory ingest API from a local manifest.
//
// Usage:
//   node tools/seed-agent-memory.mjs [manifest.json] [--dry-run]
//   Default manifest: tools/seed-manifests/2026-10-19-local-notes.json
//
// Env (network mode only):
//   MEMORY_INGEST_BASE_URL   e.g. https://host.example  (no trailing slash required)
//   MEMORY_INGEST_SECRET     HMAC-SHA256 key; never printed
//
// This tool only reads the manifest and POSTs to the configured ingest endpoint.
// It does not write any local or production files.

import fs from "node:fs";
import crypto from "node:crypto";

const BATCH_ID = "seed-local-mem-v1";
const PROMPT_VERSION = "seed-local-mem-v1";
const CONTRIBUTOR_KEY = "seed-local-mem-v1";
const DEFAULT_MANIFEST = "tools/seed-manifests/2026-10-19-local-notes.json";
const MAX_BATCH = 20;
const REQUEST_TIMEOUT_MS = 45_000;

// Existing shared-library taxonomy (ASCII domains). Do not invent new domains.
const ALLOWED_DOMAINS = new Set([
  "agent-operations", "agent-orchestration", "agent-workflow", "ai-agent-orchestration",
  "ai-animation", "ai-generated-visuals", "ai-image-generation", "ai-image-tooling",
  "ai-media-generation", "ai-music", "ai-music-generation", "ai-video", "ai-video-prompting",
  "album-cover-design", "animation", "animation-production", "animation-technique",
  "anime-music", "anime-production", "audio", "audio-analysis", "audio-editing",
  "audio-generation", "audio-mastering", "audio-processing", "audio-qa", "audio-qc",
  "audio-verification", "billing", "brand-identity", "camera-control", "camera-motion",
  "canvas-workflow", "character-consistency", "character-design", "china-marketing",
  "cinematography", "compliance", "content-ops", "copywriting", "education", "entity-tags",
  "film-production", "filmmaking", "generation-platform", "image-editing", "image-generation",
  "image-prompting", "lyric-writing", "lyrics", "mandopop", "media-qc", "multi-agent-production",
  "music", "music-generation", "music-production", "music-prompting", "narrative", "pop-culture",
  "prompt-engineering", "prompt-technique", "screenwriting", "short-video", "songwriting",
  "storyboard", "storyboard-qc", "storyboarding", "subagent-workflow", "tool-behavior",
  "video-analysis", "video-assembly", "video-compositing", "video-creation", "video-editing",
  "video-encoding", "video-generation", "video-postproduction", "video-production",
  "vocal-arrangement", "workflow", "workflow-canvas", "workflow-templates",
  "workflow-video-generation",
]);

const TYPES = new Set(["domain", "workflow", "feedback", "project"]);
const EVIDENCE_KINDS = new Set(["tool_result", "verbatim", "user_confirmed"]);

const SENSITIVE_PATTERNS = [
  [/(?:https?:\/\/|www\.)/i, "URL"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "email"],
  [/\bsk-[A-Za-z0-9_-]{8,}/, "API key"],
  [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/i, "credential header"],
  [/(?:password|passwd|secret|private[_-]?key|access[_-]?token|api[_-]?key)\s*[:=]\s*\S+/i, "secret assignment"],
  [/\/home\/|\/opt\/|\/Users\/|~\/|[A-Za-z]:\\/, "absolute path"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "IP address"],
  [/[¥￥]|\b\d+(?:\.\d+)?\s*(?:元|币|美元|USD|CNY|RMB)\b/i, "price"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "UUID"],
  [/\b[0-9a-f]{32,}\b/i, "request/hash-like id"],
];

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error("usage: node tools/seed-agent-memory.mjs [manifest.json] [--dry-run]");
  process.exit(2);
}

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function countOf(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function rejectedLines(rejected) {
  if (!Array.isArray(rejected)) return [];
  return rejected.map((item) => {
    if (typeof item === "string") return `  rejected slug=? reason=${item}`;
    const slug = item?.slug ?? item?.doc?.slug ?? item?.document?.slug ?? "?";
    const reason = item?.reason ?? item?.error?.message ?? item?.error?.code ?? item?.message ?? "unknown";
    return `  rejected slug=${slug} reason=${reason}`;
  });
}

function validateDoc(doc, index) {
  const issues = [];
  const at = `docs[${index}]`;
  const slug = present(doc?.slug) ? doc.slug : `${at}`;
  const add = (field, msg) => issues.push(`${slug}: ${field}: ${msg}`);

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return [`${at}: document must be an object`];
  }
  if (doc.scope !== "shared") add("scope", "must be \"shared\"");
  if (!present(doc.domain)) add("domain", "required string");
  else if (!ALLOWED_DOMAINS.has(doc.domain)) add("domain", `not in existing taxonomy: ${doc.domain}`);
  if (!present(doc.slug)) add("slug", "required string");
  else if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc.slug)) add("slug", "must be kebab-case");
  else if (doc.slug.length > 64) add("slug", "must be <=64 chars");
  if (!present(doc.description)) add("description", "required string");
  else if (doc.description.length > 120) add("description", "must be <=120 chars");
  if (!TYPES.has(doc.type)) add("type", "must be domain|workflow|feedback|project");
  if (!present(doc.body)) add("body", "required string");
  else {
    if (doc.body.length > 1800) add("body", "must be <=1800 chars");
    if (doc.type === "feedback" && (!doc.body.includes("**Why:**") || !doc.body.includes("**How to apply:**"))) {
      add("body", "feedback docs must contain **Why:** and **How to apply:**");
    }
  }
  if (doc.links !== undefined && !Array.isArray(doc.links)) add("links", "must be an array");
  if (!present(doc.evidence)) add("evidence", "required string");
  else if (doc.evidence.length < 10 || doc.evidence.length > 200) add("evidence", "must be 10-200 chars");
  if (!EVIDENCE_KINDS.has(doc.evidence_kind)) add("evidence_kind", "must be tool_result|verbatim|user_confirmed");
  if (!Number.isInteger(doc.self_score) || doc.self_score < 1 || doc.self_score > 5) {
    add("self_score", "must be an integer 1-5");
  }

  for (const field of ["description", "body", "evidence", "rationale"]) {
    if (typeof doc[field] !== "string") continue;
    for (const [pattern, label] of SENSITIVE_PATTERNS) {
      if (pattern.test(doc[field])) add(field, `contains sensitive pattern (${label})`);
    }
  }
  return issues;
}

function loadManifest(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (err) {
    usage(`cannot read manifest: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    usage(`manifest is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed)) usage("manifest must be a JSON array");
  return parsed;
}

function validateManifest(docs) {
  const issues = [];
  const seen = new Map();
  docs.forEach((doc, i) => {
    issues.push(...validateDoc(doc, i));
    if (present(doc?.slug)) {
      if (seen.has(doc.slug)) issues.push(`${doc.slug}: slug: duplicate (also docs[${seen.get(doc.slug)}])`);
      else seen.set(doc.slug, i);
    }
  });
  return issues;
}

function toPayloadDoc(doc) {
  return {
    scope: "shared",
    contributor_key: CONTRIBUTOR_KEY,
    domain: doc.domain,
    slug: doc.slug,
    description: doc.description,
    type: doc.type,
    body: doc.body,
    links: Array.isArray(doc.links) ? doc.links : [],
    evidence: doc.evidence,
    evidence_kind: doc.evidence_kind,
    self_score: doc.self_score,
    prompt_version: PROMPT_VERSION,
  };
}

function sign(secret, bytes) {
  return `sha256=${crypto.createHmac("sha256", secret).update(bytes).digest("hex")}`;
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function errorSummary(body) {
  if (!body || typeof body !== "object") return "";
  const code = body.error?.code ?? body.code;
  const message = body.error?.message ?? body.message;
  return [code, message].filter(Boolean).join(": ").slice(0, 300);
}

function collectSlugs(value, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectSlugs(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    if (typeof value.slug === "string") out.add(value.slug);
    for (const child of Object.values(value)) collectSlugs(child, out);
  }
  return out;
}

function parseExport(text) {
  const out = new Set();
  try {
    collectSlugs(JSON.parse(text), out);
    return out;
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        collectSlugs(JSON.parse(trimmed), out);
      } catch {
        // ignore non-JSON lines
      }
    }
    return out;
  }
}

async function postBatch(base, secret, payloadBuffer) {
  return fetch(`${base}/api/agent/memory/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-memory-signature": sign(secret, payloadBuffer),
    },
    body: payloadBuffer,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchExport(base, secret) {
  const empty = Buffer.alloc(0);
  return fetch(`${base}/api/agent/memory/export?scope=shared`, {
    method: "GET",
    headers: { "x-memory-signature": sign(secret, empty) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const manifestPath = args.find((arg) => !arg.startsWith("--")) ?? DEFAULT_MANIFEST;

  const docs = loadManifest(manifestPath);
  const issues = validateManifest(docs);
  if (issues.length > 0) {
    console.error(`validation failed: ${issues.length} issue(s)`);
    for (const issue of issues) console.error(`  ${issue}`);
    process.exit(1);
  }

  const batches = [];
  for (let i = 0; i < docs.length; i += MAX_BATCH) batches.push(docs.slice(i, i + MAX_BATCH));

  console.log(`manifest: ${manifestPath}`);
  console.log(`docs: ${docs.length}`);
  console.log(`batches: ${batches.length} (max ${MAX_BATCH}/batch)`);
  console.log("validation: OK");

  if (dryRun) {
    console.log("dry-run: no network requests sent");
    return 0;
  }

  const baseUrl = process.env.MEMORY_INGEST_BASE_URL;
  const secret = process.env.MEMORY_INGEST_SECRET;
  const missingEnv = [];
  if (!present(baseUrl)) missingEnv.push("MEMORY_INGEST_BASE_URL");
  if (!present(secret)) missingEnv.push("MEMORY_INGEST_SECRET");
  if (missingEnv.length > 0) {
    console.error(`missing env: ${missingEnv.join(", ")}`);
    return 2;
  }

  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    console.error("invalid MEMORY_INGEST_BASE_URL");
    return 2;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    console.error("MEMORY_INGEST_BASE_URL must be http(s)");
    return 2;
  }
  const normalizedBase = base.toString().replace(/\/+$/, "");

  const failedBatches = [];
  for (let i = 0; i < batches.length; i += 1) {
    const payload = {
      batch_id: BATCH_ID,
      prompt_version: PROMPT_VERSION,
      seed: true,
      docs: batches[i].map(toPayloadDoc),
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");

    let res;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        res = await postBatch(normalizedBase, secret, body);
        break;
      } catch (err) {
        const cause = err?.cause;
        const causeText = [cause?.code, cause?.message].filter(Boolean).join(": ");
        console.error(
          `batch ${i + 1}/${batches.length}: request failed (attempt ${attempt + 1}/2): ${err.message}${causeText ? ` (${causeText})` : ""}`,
        );
        if (attempt === 0) {
          console.error(`batch ${i + 1}/${batches.length}: retrying in 1s`);
          await sleep(1000);
        }
      }
    }
    if (!res) {
      failedBatches.push(i + 1);
      continue;
    }

    const json = await readJsonResponse(res);
    const accepted = countOf(json.accepted);
    const proposals = countOf(json.proposals);
    const rejected = json.rejected;
    console.log(
      `batch ${i + 1}/${batches.length}: status=${res.status} accepted=${accepted} proposals=${proposals} rejected=${countOf(rejected)}`,
    );
    for (const line of rejectedLines(rejected)) console.log(line);
    if (!res.ok) {
      const summary = errorSummary(json);
      if (summary) console.log(`  error: ${summary}`);
      failedBatches.push(i + 1);
    }
  }

  let exportSlugs;
  try {
    const res = await fetchExport(normalizedBase, secret);
    const text = await res.text();
    if (!res.ok) {
      let errJson = {};
      try {
        errJson = JSON.parse(text);
      } catch {
        // ignore non-JSON error body
      }
      const summary = errorSummary(errJson);
      console.error(`export: status=${res.status}${summary ? ` ${summary}` : ""}`);
      console.log(`write failures: ${failedBatches.length > 0 ? `batch ${failedBatches.join(", ")}` : "none"}`);
      console.log("readback missing: unknown (export request failed)");
      return 1;
    }
    exportSlugs = parseExport(text);
  } catch (err) {
    console.error(`export: request failed: ${err.message}`);
    console.log(`write failures: ${failedBatches.length > 0 ? `batch ${failedBatches.join(", ")}` : "none"}`);
    console.log("readback missing: unknown (export request failed)");
    return 1;
  }

  const missing = docs.map((doc) => doc.slug).filter((slug) => !exportSlugs.has(slug));
  console.log(`export: ${exportSlugs.size} slug(s); missing=${missing.length}`);
  if (missing.length > 0) {
    console.log("missing:");
    for (const slug of missing) console.log(`  ${slug}`);
  } else {
    console.log("missing: none");
  }
  console.log(`write failures: ${failedBatches.length > 0 ? `batch ${failedBatches.join(", ")}` : "none"}`);
  console.log(`readback missing: ${missing.length}`);

  if (failedBatches.length > 0 || missing.length > 0) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`fatal: ${err?.message ?? String(err)}`);
    process.exit(1);
  });
