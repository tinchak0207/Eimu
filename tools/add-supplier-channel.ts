// 一键接入新生图渠道：把渠道条目写进 src/lib/supplier-channels.config.ts 的
// REGISTRY-ENTRIES 标记区（marker 定位字串操作），跑 tsc 验证语法，失败即还原。
// 脚本本身不做部署；收尾输出需要在 VPS .env.control-plane 加的行与部署命令。
//
// 用法：
//   npx tsx tools/add-supplier-channel.ts <label> <baseUrl> --api-key-env HUBLINUXDO_API_KEY \
//     --models gpt-image-2,gemini-3.1-flash-image,gemini-3-image=gemini-3-pro-image \
//     [--kinds image_generate] [--chat-models gemini-3-pro-image] \
//     [--tier relay] [--site-priority 25] \
//     [--enabled-env HUBLINUXDO_ENABLED] [--probe --key <apikey>] [--force]
//
// models 语法：`platformId`（同名直传）或 `platformId=upstreamId`（上游改名）。

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { RegistryChannel, RegistryChannelClaim, RegistryClaimKind } from "../src/lib/supplier-channels.config";
import { listSupplyProtocols } from "../src/lib/generation-core/supply-registry";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "supplier-channels.config.ts");
const ROUTES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "model-routes.config.ts");

/**
 * 把新渠道 label 追加到所认领模型的路由**队尾**（调度序最低）。调序请改
 * model-routes.config.ts 阵列顺序或在 /admin「模型路由」覆写。
 * 模型尚无路由行时，在 MODEL_ROUTES 结尾补一行。
 */
export function appendLabelToRoutes(source: string, label: string, modelIds: string[]): string {
  const tableStart = source.indexOf("export const MODEL_ROUTES");
  if (tableStart === -1) throw new Error(`${ROUTES_PATH} 找不到 MODEL_ROUTES。`);
  const tableEnd = source.indexOf("\n};", tableStart);
  if (tableEnd === -1) throw new Error(`${ROUTES_PATH} 的 MODEL_ROUTES 没有结尾 "};"。`);
  let head = source.slice(0, tableEnd);
  const tail = source.slice(tableEnd);
  for (const modelId of [...new Set(modelIds)]) {
    const escaped = modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const line = new RegExp(`^(\\s*"${escaped}":\\s*\\[)([^\\]]*)(\\],?)`, "m");
    const match = line.exec(head.slice(tableStart));
    if (match) {
      const labels = match[2].split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
      if (labels.includes(label)) continue;
      const replaced = `${match[1]}${[...labels, label].map((item) => JSON.stringify(item)).join(", ")}${match[3]}`;
      const at = tableStart + match.index;
      head = head.slice(0, at) + replaced + head.slice(at + match[0].length);
    } else {
      head += `\n  ${JSON.stringify(modelId)}: [${JSON.stringify(label)}],`;
    }
  }
  return head + tail;
}

const START_MARKER = "// REGISTRY-ENTRIES-START";
const END_MARKER = "// REGISTRY-ENTRIES-END";

const USAGE = `用法：
  npx tsx tools/add-supplier-channel.ts <label> <baseUrl> --api-key-env <ENV> --models <list> [options]

参数：
  <label>                    渠道名（env channel label，同时是 DB supplier label）
  <baseUrl>                  上游 base URL（例：https://relay.example/v1）
  --api-key-env <ENV>        API key 的环境变数名（同时作为 credentialRef）
  --models <list>            平台模型清单，逗号分隔；条目语法 platformId 或 platformId=upstreamId
  --kinds <list>             认领的 kind（预设 image_generate；可选 image_generate,image_edit,video_generate,tts）
  --chat-models <list>       走 /chat/completions 生图的上游模型名（逗号分隔，预设空）
  --adapter <a>              openai_images（预设）| metaso（自订协议，见 metaso-upstream.ts）
  --tier <t>                 first_party | managed_pool | relay | fallback（预设 relay）
  --site-priority <n>        站点队列 ENV_CHANNEL_PRIORITIES 用（预设 25）
  --enabled-env <ENV>        有值时：清洗后 === "true" 才 defaultEnabled
  --probe --key <apikey>     GET 上游 /v1/models 核对模型清单（只 WARN 不挡）
  --force                    label 已存在时替换该条目（否则报错退出）
  --help                     显示本说明`;

interface Args {
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  kinds: RegistryClaimKind[];
  chatModels: string[];
  tier: RegistryChannel["tier"];
  adapter: RegistryChannel["adapterType"];
  sitePriority: number;
  enabledEnv: string | null;
  probe: boolean;
  probeKey: string | null;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (name === "probe" || name === "force") {
        flags[name] = true;
      } else {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          console.error(`错误：--${name} 需要一个值。\n\n${USAGE}`);
          process.exit(1);
        }
        flags[name] = value;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    console.error(`错误：需要恰好两个位置参数 <label> <baseUrl>。\n\n${USAGE}`);
    process.exit(1);
  }
  const [label, baseUrl] = positional;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    console.error(`错误：label "${label}" 只能含小写字母/数字/连字号（它会进 env:${label} 等 id）。`);
    process.exit(1);
  }
  const apiKeyEnv = String(flags["api-key-env"] ?? "");
  if (!apiKeyEnv) {
    console.error(`错误：--api-key-env 为必填。\n\n${USAGE}`);
    process.exit(1);
  }
  const modelsRaw = String(flags["models"] ?? "");
  if (!modelsRaw.trim()) {
    console.error(`错误：--models 为必填（至少一个平台模型 id）。\n\n${USAGE}`);
    process.exit(1);
  }
  const kindsRaw = String(flags["kinds"] ?? "image_generate")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const kind of kindsRaw) {
    if (kind !== "image_generate" && kind !== "image_edit" && kind !== "video_generate" && kind !== "tts") {
      console.error(`错误：未知 kind "${kind}"（可选 image_generate / image_edit / video_generate / tts）。`);
      process.exit(1);
    }
  }
  const tier = String(flags["tier"] ?? "relay") as RegistryChannel["tier"];
  if (!["first_party", "managed_pool", "relay", "fallback"].includes(tier)) {
    console.error(`错误：未知 tier "${tier}"。`);
    process.exit(1);
  }
  const adapterRaw = String(flags["adapter"] ?? "openai_images");
  // 合法协议＝supply-registry 已注册的 protocol（V-06：不再在工具里写死清单）。
  const ADAPTERS = listSupplyProtocols();
  if (!ADAPTERS.includes(adapterRaw)) {
    console.error(`错误：未知 adapter "${adapterRaw}"（可选 ${ADAPTERS.join(" / ")}）。`);
    process.exit(1);
  }
  return {
    label,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKeyEnv,
    models: modelsRaw.split(",").map((x) => x.trim()).filter(Boolean),
    kinds: kindsRaw as RegistryClaimKind[],
    chatModels: String(flags["chat-models"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
    tier,
    adapter: adapterRaw as RegistryChannel["adapterType"],
    sitePriority: Number(flags["site-priority"] ?? 25),
    enabledEnv: flags["enabled-env"] ? String(flags["enabled-env"]) : null,
    probe: flags.probe === true,
    probeKey: flags.key ? String(flags.key) : null,
    force: flags.force === true,
  };
}

function parseClaims(modelSpecs: string[], kinds: RegistryClaimKind[]): RegistryChannelClaim[] {
  return modelSpecs.map((spec) => {
    const eq = spec.indexOf("=");
    if (eq === -1) return { modelId: spec, supplierModelId: null, kinds: [...kinds] };
    return { modelId: spec.slice(0, eq), supplierModelId: spec.slice(eq + 1), kinds: [...kinds] };
  });
}

/** 渲染单一 registry 条目为 config 档内的格式化文本（2 空格缩排）。 */
function renderEntry(channel: RegistryChannel): string {
  const lines: string[] = [];
  lines.push(`  {`);
  lines.push(`    label: ${JSON.stringify(channel.label)},`);
  lines.push(`    baseUrlEnv: ${JSON.stringify(channel.baseUrlEnv)},`);
  lines.push(`    apiKeyEnv: ${JSON.stringify(channel.apiKeyEnv)},`);
  lines.push(`    enabledEnv: ${JSON.stringify(channel.enabledEnv)},`);
  lines.push(`    tier: ${JSON.stringify(channel.tier)},`);
  lines.push(`    sitePriority: ${channel.sitePriority},`);
  lines.push(`    chatImageModels: [${channel.chatImageModels.map((m) => JSON.stringify(m)).join(", ")}],`);
  if (channel.adapterType && channel.adapterType !== "openai_images") {
    lines.push(`    adapterType: ${JSON.stringify(channel.adapterType)},`);
  }
  if (channel.claims.length === 0) {
    lines.push(`    claims: [],`);
  } else {
    lines.push(`    claims: [`);
    for (const claim of channel.claims) {
      lines.push(`      {`);
      lines.push(`        modelId: ${JSON.stringify(claim.modelId)},`);
      lines.push(`        supplierModelId: ${JSON.stringify(claim.supplierModelId)},`);
      lines.push(`        kinds: [${claim.kinds.map((k) => JSON.stringify(k)).join(", ")}],`);
      lines.push(`      },`);
    }
    lines.push(`    ],`);
  }
  lines.push(`  },`);
  return lines.join("\n");
}

/** 解析现有标记区内的条目 label（含 marker 行的定位资讯）。 */
function splitConfig(source: string): { before: string; entries: string; after: string } {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${CONFIG_PATH} 缺少 ${START_MARKER} / ${END_MARKER} 标记对，无法定位插入点。`);
  }
  // START_MARKER 是行首注释的开头，同行还有说明文字；行（含换行）整体属于 before。
  const startLineEnd = source.indexOf("\n", start);
  return {
    before: source.slice(0, startLineEnd + 1),
    entries: source.slice(startLineEnd + 1, end).trim(),
    after: source.slice(end),
  };
}

function entryLabels(entries: string): string[] {
  const labels: string[] = [];
  const re = /label:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(entries))) labels.push(match[1]);
  return labels;
}

async function probeUpstream(baseUrl: string, apiKey: string | null, claims: RegistryChannelClaim[]): Promise<void> {
  if (!apiKey) {
    console.warn("[probe] --probe 需要同时给 --key <apikey>，跳过核对。");
    return;
  }
  const base = baseUrl.replace(/\/+$/, "");
  const url = /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
  console.log(`[probe] GET ${url}`);
  let payload: unknown;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.warn(`[probe] 上游回 HTTP ${response.status}，无法核对模型清单（不挡写入）。`);
      return;
    }
    payload = await response.json();
  } catch (error) {
    console.warn(`[probe] 请求失败：${error instanceof Error ? error.message : String(error)}（不挡写入）。`);
    return;
  }
  const upstreamModels = new Set<string>(
    Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: Array<{ id?: unknown }> }).data)
          .map((item) => item?.id)
          .filter((id): id is string => typeof id === "string")
      : [],
  );
  if (!upstreamModels.size) {
    console.warn("[probe] 回应里没有可解析的模型清单（data[].id），跳过核对。");
    return;
  }
  for (const claim of claims) {
    const upstream = claim.supplierModelId ?? claim.modelId;
    if (upstreamModels.has(upstream)) {
      console.log(`[probe] OK   ${claim.modelId} -> ${upstream}`);
    } else {
      console.warn(`[probe] WARN ${claim.modelId} -> ${upstream} 不在上游 /models 清单中`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const claims = parseClaims(args.models, args.kinds);
  const channel: RegistryChannel = {
    label: args.label,
    baseUrlEnv: `${args.label.replace(/-/g, "_").toUpperCase()}_BASE_URL`,
    apiKeyEnv: args.apiKeyEnv,
    enabledEnv: args.enabledEnv,
    tier: args.tier,
    sitePriority: args.sitePriority,
    chatImageModels: args.chatModels,
    adapterType: args.adapter,
    claims,
  };

  if (args.probe) await probeUpstream(args.baseUrl, args.probeKey, claims);

  const source = readFileSync(CONFIG_PATH, "utf8");
  const { before, entries, after } = splitConfig(source);
  const existing = entryLabels(entries);
  if (existing.includes(args.label) && !args.force) {
    console.error(`错误：渠道 "${args.label}" 已存在于 registry；要替换请加 --force。`);
    process.exit(1);
  }

  // 重建标记区：去掉被替换 label 的旧条目，插入新条目（2 空格缩排，逐条一行分隔）。
  const entryBlocks = entries.split(/\n(?=  \{)/).map((block) => block.trim()).filter(Boolean);
  const kept = entryBlocks.filter((block) => !new RegExp(`label:\\s*"${args.label}"`).test(block));
  const rendered = renderEntry(channel);
  const blocks = [...kept, rendered];
  const nextSource = `${before}${blocks.join("\n\n")}\n  ${after}`;

  const backup = source;
  writeFileSync(CONFIG_PATH, nextSource, "utf8");
  console.log(`[add-supplier-channel] 已写入 ${CONFIG_PATH}（渠道 "${args.label}"${existing.includes(args.label) ? "，替换旧条目" : ""}）。`);
  const routesBackup = readFileSync(ROUTES_PATH, "utf8");
  writeFileSync(ROUTES_PATH, appendLabelToRoutes(routesBackup, args.label, claims.map((claim) => claim.modelId)), "utf8");
  console.log(`[add-supplier-channel] 已把 "${args.label}" 追加到 ${claims.length} 个模型的路由队尾（${ROUTES_PATH}）。`);

  // 语法验证：tsc 失败即还原。
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { stdio: "pipe", shell: process.platform === "win32", cwd: dirname(CONFIG_PATH) });
  if (tsc.status !== 0) {
    writeFileSync(CONFIG_PATH, backup, "utf8");
    writeFileSync(ROUTES_PATH, routesBackup, "utf8");
    console.error("[add-supplier-channel] tsc --noEmit 失败，已还原原档。错误输出：");
    console.error(tsc.stdout?.toString() ?? "");
    console.error(tsc.stderr?.toString() ?? "");
    process.exit(1);
  }
  console.log("[add-supplier-channel] tsc --noEmit 通过。");

  const enabledLine = channel.enabledEnv ? `${channel.enabledEnv}=true` : `（无 enabled env：配置好 base URL + key 即 defaultEnabled）`;
  console.log(`
收尾指引（脚本不做部署）：

1. VPS /opt/image-control-plane/app/.env.control-plane 加：
   ${channel.baseUrlEnv}=${args.baseUrl}
   ${channel.apiKeyEnv}=<你的 key>   # key 值不落任何 log
   ${enabledLine}

2. 同步本专案代码到 VPS 后重建并 seed：
   docker compose -f control-plane-compose.yml build generation-worker
   docker compose -f control-plane-compose.yml run --rm generation-worker npx tsx tools/seed-generation-suppliers.ts
   docker compose -f control-plane-compose.yml up -d generation-worker

3. 站点（Vercel）若要让 admin 队列显示该渠道，同步部署站点（registry config 已打包进 lambda）。
`);
}

// 直接执行才跑 main；测试 import appendLabelToRoutes 时不触发。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("[add-supplier-channel] failed", error);
    process.exitCode = 1;
  });
}
