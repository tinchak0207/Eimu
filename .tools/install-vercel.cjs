
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const STORE = path.resolve(".tools/vstore/node_modules");
fs.mkdirSync(STORE, { recursive: true });

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(url + " -> " + res.status);
  return res.json();
}

const installed = new Set();

async function install(name, versionRange) {
  const key = name + "@" + versionRange;
  if (installed.has(key)) return;
  installed.add(key);
  const meta = await getJson("https://registry.npmjs.org/" + encodeURIComponent(name));
  let version = versionRange;
  if (versionRange.startsWith("^") || versionRange.startsWith("~")) {
    const base = versionRange.slice(1);
    const candidates = Object.keys(meta.versions).filter(v => v.startsWith(base.split(".")[0] + "."));
    version = candidates[candidates.length - 1] || base;
  } else if (versionRange === "latest") {
    version = meta["dist-tags"].latest;
  }
  const vmeta = meta.versions[version];
  if (!vmeta) throw new Error("no version " + name + " " + version);
  const tarUrl = vmeta.dist.tarball;
  const tgz = path.resolve(".tools/vstore", name.replace("/", "_") + ".tgz");
  const res = await fetch(tarUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tgz, buf);
  const dest = path.join(STORE, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execSync("tar -xzf " + JSON.stringify(tgz) + " -C " + JSON.stringify(dest) + " --strip-components=1");
  process.stderr.write("installed " + name + "@" + version + "\n");
  const deps = vmeta.dependencies || {};
  for (const [d, r] of Object.entries(deps)) {
    // 只跟 runtime 依賴；可選 peer 跳過
    try { await install(d, r); } catch (e) { process.stderr.write("skip " + d + ": " + e.message + "\n"); }
  }
}

(async () => {
  await install("vercel", "latest");
  console.log("DONE");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
