// 一鍵接入新生圖渠道：把渠道條目寫進 src/lib/supplier-channels.config.ts 的
// REGISTRY-ENTRIES 標記區（marker 定位字串操作），跑 tsc 驗證語法，失敗即還原。
// 腳本本身不做部署；收尾輸出需要在 VPS .env.control-plane 加的行與部署命令。
//
// 用法：
//   npx tsx tools/add-supplier-channel.ts <label> <baseUrl> --api-key-env HUBLINUXDO_API_KEY \
//     --models gpt-image-2,gemini-3.1-flash-image,gemini-3-image=gemini-3-pro-image \
//     [--kinds image_generate] [--chat-models gemini-3-pro-image] \
//     [--tier relay] [--seed-priority 25] [--site-priority 25] \
//     [--enabled-env HUBLINUXDO_ENABLED] [--probe --key <apikey>] [--force]
//
// models 語法：`platformId`（同名直傳）或 `platformId=upstreamId`（上游改名）。

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import type { RegistryChannel, RegistryChannelClaim, RegistryClaimKind } from "../src/lib/supplier-channels.config";
import { listSupplyProtocols } from "../src/lib/generation-core/supply-registry";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "supplier-channels.config.ts");
const START_MARKER = "// REGISTRY-ENTRIES-START";
const END_MARKER = "// REGISTRY-ENTRIES-END";

const USAGE = `用法：
  npx tsx tools/add-supplier-channel.ts <label> <baseUrl> --api-key-env <ENV> --models <list> [options]

參數：
  <label>                    渠道名（env channel label，同時是 DB supplier label）
  <baseUrl>                  上游 base URL（例：https://relay.example/v1）
  --api-key-env <ENV>        API key 的環境變數名（同時作為 credentialRef）
  --models <list>            平台模型清單，逗號分隔；條目語法 platformId 或 platformId=upstreamId
  --kinds <list>             認領的 kind（預設 image_generate；可選 image_generate,image_edit,video_generate）
  --chat-models <list>       走 /chat/completions 生圖的上游模型名（逗號分隔，預設空）
  --adapter <a>              openai_images（預設）| metaso（自訂協議，見 metaso-upstream.ts）
  --tier <t>                 first_party | managed_pool | relay | fallback（預設 relay）
  --seed-priority <n>        seed 進 supplier 表的 priority（預設 25）
  --site-priority <n>        站點隊列 ENV_CHANNEL_PRIORITIES 用（預設 25）
  --enabled-env <ENV>        有值時：清洗後 === "true" 才 defaultEnabled
  --probe --key <apikey>     GET 上游 /v1/models 核對模型清單（只 WARN 不擋）
  --force                    label 已存在時替換該條目（否則報錯退出）
  --help                     顯示本說明`;

interface Args {
  label: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  kinds: RegistryClaimKind[];
  chatModels: string[];
  tier: RegistryChannel["tier"];
  adapter: RegistryChannel["adapterType"];
  seedPriority: number;
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
          console.error(`錯誤：--${name} 需要一個值。\n\n${USAGE}`);
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
    console.error(`錯誤：需要恰好兩個位置參數 <label> <baseUrl>。\n\n${USAGE}`);
    process.exit(1);
  }
  const [label, baseUrl] = positional;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) {
    console.error(`錯誤：label "${label}" 只能含小寫字母/數字/連字號（它會進 env:${label} 等 id）。`);
    process.exit(1);
  }
  const apiKeyEnv = String(flags["api-key-env"] ?? "");
  if (!apiKeyEnv) {
    console.error(`錯誤：--api-key-env 為必填。\n\n${USAGE}`);
    process.exit(1);
  }
  const modelsRaw = String(flags["models"] ?? "");
  if (!modelsRaw.trim()) {
    console.error(`錯誤：--models 為必填（至少一個平台模型 id）。\n\n${USAGE}`);
    process.exit(1);
  }
  const kindsRaw = String(flags["kinds"] ?? "image_generate")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const kind of kindsRaw) {
    if (kind !== "image_generate" && kind !== "image_edit" && kind !== "video_generate") {
      console.error(`錯誤：未知 kind "${kind}"（可選 image_generate / image_edit / video_generate）。`);
      process.exit(1);
    }
  }
  const tier = String(flags["tier"] ?? "relay") as RegistryChannel["tier"];
  if (!["first_party", "managed_pool", "relay", "fallback"].includes(tier)) {
    console.error(`錯誤：未知 tier "${tier}"。`);
    process.exit(1);
  }
  const adapterRaw = String(flags["adapter"] ?? "openai_images");
  // 合法協議＝supply-registry 已註冊的 protocol（V-06：不再在工具裡寫死清單）。
  const ADAPTERS = listSupplyProtocols();
  if (!ADAPTERS.includes(adapterRaw)) {
    console.error(`錯誤：未知 adapter "${adapterRaw}"（可選 ${ADAPTERS.join(" / ")}）。`);
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
    seedPriority: Number(flags["seed-priority"] ?? 25),
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

/** 渲染單一 registry 條目為 config 檔內的格式化文本（2 空格縮排）。 */
function renderEntry(channel: RegistryChannel): string {
  const lines: string[] = [];
  lines.push(`  {`);
  lines.push(`    label: ${JSON.stringify(channel.label)},`);
  lines.push(`    baseUrlEnv: ${JSON.stringify(channel.baseUrlEnv)},`);
  lines.push(`    apiKeyEnv: ${JSON.stringify(channel.apiKeyEnv)},`);
  lines.push(`    enabledEnv: ${JSON.stringify(channel.enabledEnv)},`);
  lines.push(`    tier: ${JSON.stringify(channel.tier)},`);
  lines.push(`    seedPriority: ${channel.seedPriority},`);
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

/** 解析現有標記區內的條目 label（含 marker 行的定位資訊）。 */
function splitConfig(source: string): { before: string; entries: string; after: string } {
  const start = source.indexOf(START_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`${CONFIG_PATH} 缺少 ${START_MARKER} / ${END_MARKER} 標記對，無法定位插入點。`);
  }
  // START_MARKER 是行首註釋的開頭，同行還有說明文字；行（含換行）整體屬於 before。
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
    console.warn("[probe] --probe 需要同時給 --key <apikey>，跳過核對。");
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
      console.warn(`[probe] 上游回 HTTP ${response.status}，無法核對模型清單（不擋寫入）。`);
      return;
    }
    payload = await response.json();
  } catch (error) {
    console.warn(`[probe] 請求失敗：${error instanceof Error ? error.message : String(error)}（不擋寫入）。`);
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
    console.warn("[probe] 回應裡沒有可解析的模型清單（data[].id），跳過核對。");
    return;
  }
  for (const claim of claims) {
    const upstream = claim.supplierModelId ?? claim.modelId;
    if (upstreamModels.has(upstream)) {
      console.log(`[probe] OK   ${claim.modelId} -> ${upstream}`);
    } else {
      console.warn(`[probe] WARN ${claim.modelId} -> ${upstream} 不在上游 /models 清單中`);
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
    seedPriority: args.seedPriority,
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
    console.error(`錯誤：渠道 "${args.label}" 已存在於 registry；要替換請加 --force。`);
    process.exit(1);
  }

  // 重建標記區：去掉被替換 label 的舊條目，插入新條目（2 空格縮排，逐條一行分隔）。
  const entryBlocks = entries.split(/\n(?=  \{)/).map((block) => block.trim()).filter(Boolean);
  const kept = entryBlocks.filter((block) => !new RegExp(`label:\\s*"${args.label}"`).test(block));
  const rendered = renderEntry(channel);
  const blocks = [...kept, rendered];
  const nextSource = `${before}${blocks.join("\n\n")}\n  ${after}`;

  const backup = source;
  writeFileSync(CONFIG_PATH, nextSource, "utf8");
  console.log(`[add-supplier-channel] 已寫入 ${CONFIG_PATH}（渠道 "${args.label}"${existing.includes(args.label) ? "，替換舊條目" : ""}）。`);

  // 語法驗證：tsc 失敗即還原。
  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { stdio: "pipe", shell: process.platform === "win32", cwd: dirname(CONFIG_PATH) });
  if (tsc.status !== 0) {
    writeFileSync(CONFIG_PATH, backup, "utf8");
    console.error("[add-supplier-channel] tsc --noEmit 失敗，已還原原檔。錯誤輸出：");
    console.error(tsc.stdout?.toString() ?? "");
    console.error(tsc.stderr?.toString() ?? "");
    process.exit(1);
  }
  console.log("[add-supplier-channel] tsc --noEmit 通過。");

  const enabledLine = channel.enabledEnv ? `${channel.enabledEnv}=true` : `（無 enabled env：配置好 base URL + key 即 defaultEnabled）`;
  console.log(`
收尾指引（腳本不做部署）：

1. VPS /opt/image-control-plane/app/.env.control-plane 加：
   ${channel.baseUrlEnv}=${args.baseUrl}
   ${channel.apiKeyEnv}=<你的 key>   # key 值不落任何 log
   ${enabledLine}

2. 同步本專案代碼到 VPS 後重建並 seed：
   docker compose -f control-plane-compose.yml build generation-worker
   docker compose -f control-plane-compose.yml run --rm generation-worker npx tsx tools/seed-generation-suppliers.ts
   docker compose -f control-plane-compose.yml up -d generation-worker

3. 站點（Vercel）若要讓 admin 隊列顯示該渠道，同步部署站點（registry config 已打包進 lambda）。
`);
}

main().catch((error) => {
  console.error("[add-supplier-channel] failed", error);
  process.exitCode = 1;
});
