// Compatibility probe only: imports tool definitions, never calls execute().
// OpenCode 1.18.14 embeds Zod 4.1.8; project/root Zod is not an equivalent oracle.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHECKER_PATH = "tools/check-opencode-tool-schemas.mjs";
const RUNTIME_PATH = "deploy-staging/opencode-runtime";
const HOOK_PATH = "deploy-staging/gateway/lyric-align-hook.ts";
const SOURCE_PATHS = ["tools", "lib", "package.json", "bun.lock"].map((name) => `${RUNTIME_PATH}/${name}`).concat(HOOK_PATH, CHECKER_PATH);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    const details = result.error?.message ?? result.stderr?.toString().trim() ?? "";
    const error = new Error(`${executable.split("/").pop()} failed${result.signal ? ` (${result.signal})` : ""}: ${details}`);
    error.exitCode = Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    throw error;
  }
  return result.stdout;
}

function parseArguments(args) {
  if (!args.length || (args.length === 1 && !args[0].startsWith("--"))) {
    return { runtime: resolve(args[0] ?? RUNTIME_PATH) };
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--commit", "--repo"].includes(flag) || options[flag.slice(2)] || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("Usage: bun tools/check-opencode-tool-schemas.mjs [runtime-dir | --commit <ref> --repo <repository>]");
    }
    options[flag.slice(2)] = args[++i];
  }
  if (!options.commit || !options.repo) throw new Error("--commit and --repo are both required");
  return { commit: options.commit, repo: resolve(options.repo) };
}

async function checkCommit({ repo, commit }) {
  // Resolve and authenticate the checker before creating a temporary directory.
  const resolvedCommit = command("git", ["-C", repo, "rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`]).trim();
  const candidateChecker = command("git", ["-C", repo, "show", `${resolvedCommit}:${CHECKER_PATH}`], { encoding: null });
  const checkerHash = sha256(await readFile(fileURLToPath(import.meta.url)));
  if (checkerHash !== sha256(candidateChecker)) throw new Error("Executing checker differs from the selected commit; commit the reviewed checker or run that commit's checker");
  const entries = command("git", ["-C", repo, "ls-tree", "-r", "-z", resolvedCommit, "--", ...SOURCE_PATHS]).split("\0").filter(Boolean).map((entry) => {
    const [header, path] = entry.split("\t");
    const [mode, type] = header.split(" ");
    if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error(`Unsupported candidate source entry: ${path}`);
    return { mode, path };
  });
  const stage = await mkdtemp(join(tmpdir(), "opencode-schema-"));
  try {
    const archive = join(stage, "source.tar");
    command("git", ["-C", repo, "archive", "--format=tar", `--output=${archive}`, resolvedCommit, "--", ...SOURCE_PATHS]);
    command("tar", ["-xf", archive, "-C", stage]);
    const manifest = [];
    for (const { mode, path } of entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      manifest.push(`${mode} ${sha256(await readFile(join(stage, path)))} ${path}\0`);
    }
    const sourceHash = sha256(manifest.join(""));
    // Match the deployed sibling gateway layout using this same commit's source.
    await mkdir(join(stage, "gateway"));
    await rename(join(stage, HOOK_PATH), join(stage, "gateway/lyric-align-hook.ts"));
    const runtime = join(stage, RUNTIME_PATH);
    const lock = join(runtime, "bun.lock");
    await writeFile(lock, (await readFile(lock, "utf8")).replaceAll("http://mirrors.tencentyun.com/npm/", "https://registry.npmjs.org/"));
    const home = join(stage, "home"), config = join(stage, "config"), cache = join(stage, "cache");
    await Promise.all([home, config, cache].map((path) => mkdir(path)));
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, BUN_INSTALL_CACHE_DIR: join(cache, "bun") };
    command(process.execPath, ["install", "--cwd", runtime, "--frozen-lockfile", "--ignore-scripts"], { cwd: stage, env, timeout: 120_000 });
    const output = command(process.execPath, [join(stage, CHECKER_PATH), runtime], { cwd: stage, env, timeout: 120_000 });
    const receipt = JSON.parse(output.trim());
    if (receipt.check !== "tool-schema-compatibility" || !receipt.definitions) throw new Error("Compatibility child returned no valid receipt");
    console.log(JSON.stringify({ ...receipt, resolved_commit: resolvedCommit, checker_sha256: checkerHash, source_manifest_sha256: sourceHash }));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function toolFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await toolFiles(directory, path));
    else if (entry.isFile() && /\.(js|ts)$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

async function checkRuntime(runtime) {
const toolPath = Bun.resolveSync("@opencode-ai/plugin/tool", runtime);
const pluginRequire = createRequire(toolPath);
const plugin = JSON.parse(await readFile(join(dirname(toolPath), "../package.json"), "utf8"));
const zodPath = Bun.resolveSync("zod", dirname(toolPath));
const zodVersion = pluginRequire("zod/package.json").version;
if (plugin.version !== "1.18.14" || zodVersion !== "4.1.8") {
  throw new Error(`Review production compatibility before changing plugin/Zod: ${plugin.version}/${zodVersion}`);
}
if (!toolPath.startsWith(join(runtime, "node_modules") + "/") || !zodPath.startsWith(join(runtime, "node_modules") + "/")) {
  throw new Error("Runtime dependencies must be installed inside the isolated runtime; root fallback is forbidden");
}
const { tool } = await import(pathToFileURL(toolPath).href);
const { z } = await import(pathToFileURL(zodPath).href);
if (tool.schema !== z) throw new Error("Tool schemas and compatibility probe resolved different Zod instances");

// No server/model requests are permitted while importing definitions.
globalThis.fetch = () => { throw new Error("Network request during tool-schema import is forbidden"); };
process.exit = (code) => { throw new Error(`process.exit(${code}) during tool-schema import is forbidden`); };
const files = await toolFiles(join(runtime, "tools"));
if (!files.length) throw new Error("No runtime tool files found");
let checked = 0;
for (const file of files) {
  const definitions = await import(pathToFileURL(join(runtime, "tools", file)).href);
  const primary = definitions.default;
  if (!primary || typeof primary !== "object" || !primary.args || typeof primary.args !== "object" || Array.isArray(primary.args) || typeof primary.description !== "string" || typeof primary.execute !== "function") {
    throw new Error(`Tool file has no valid default tool definition: ${file}`);
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (!definition || typeof definition !== "object" || !("args" in definition) || !("execute" in definition)) continue;
    try {
      z.toJSONSchema(z.object(definition.args), { io: "input" });
      checked++;
    } catch (error) {
      throw new Error(`Tool schema conversion failed: ${file}:${name}`, { cause: error });
    }
  }
}
if (!checked) throw new Error("No tool definitions were checked");
console.log(JSON.stringify({ check: "tool-schema-compatibility", plugin: plugin.version, zod: zodVersion, files: files.length, definitions: checked, executeCalls: 0 }));
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (Bun.version !== "1.4.2") throw new Error(`Use the reviewed Bun 1.4.2 runtime, found ${Bun.version}`);
  if (options.commit) await checkCommit(options);
  else await checkRuntime(options.runtime);
} catch (error) {
  console.error(error.stack ?? String(error));
  process.exitCode = error.exitCode ?? 1;
}
