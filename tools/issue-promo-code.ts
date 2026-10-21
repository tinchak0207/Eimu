#!/usr/bin/env -S npx tsx
//
// 从命令列签发「宣传用」兑换码（一次性、非现金）。
//
// 为什么需要它：站上产码的两条路径（mPay 履约 `mapay-redemption.ts`、订阅履约
// `subscription-redemption.ts`）都绑死业务订单与自己的命名约定，且都是**幂等**的
// （同名同额只会有一张）。发宣传码要的刚好相反——每次都生一张全新的码——所以这里
// 走同一个上游端点（`POST <gateway>/api/redemption/`），只把 name 换成人类可读的
// 宣传前缀。**不另写一套闸道逻辑**：env 载入逐字沿用 `tools/issue-biz-key.ts`，
// 额度换算沿用 `src/lib/quota-constants.ts` 的 QUOTA_PER_COIN（1 币 = 500,000）。
//
// 命名即帐务语义（见 account-ledger.isCashBackedRedemptionName）：
//   ・只有 `MP<orderId>` 开头才是「真金白银买来的」→ 记成营收；
//   ・`PROMO-*` 这种人工码一律非现金（source = gift-manual-code），不会谎报营收。
//   所以本档的预设前缀刻意**不能**是 `MP`。
//
// 用法：
//   npx tsx tools/issue-promo-code.ts                          # 30 币一张
//   npx tsx tools/issue-promo-code.ts --coins 100 --count 5    # 100 币五张
//   npx tsx tools/issue-promo-code.ts --coins 30 --expires 30  # 30 天后过期
//   npx tsx tools/issue-promo-code.ts --prefix BILIBILI-1010    # 自订前缀（方便对帐）
//   npx tsx tools/issue-promo-code.ts --dry-run                 # 只印请求，不发码
//
// 凭证从哪来：`--env-file <路径>` 指定，或依序找 `.env.production` /
// `.env.production.local` / `.env.local` / `.env.pulled`。缺凭证时自行
// `vercel env pull .env.production.local`（或从部署环境取）即可，本档不猜。

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { QUOTA_PER_COIN } from "../src/lib/quota-constants";

const root = process.cwd();

/** 从 .env* 载入脚本需要的变数；真实凭证不落在仓库里的其他地方。 */
function loadEnvFile(file: string): void {
  let content: string;
  try {
    content = readFileSync(file.startsWith("/") ? file : join(root, file), "utf8");
  } catch {
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.replace(/^"(.*)"$/, "$1");
    // 已被抹除的占位值不要覆盖真实环境变数
    if (!value || value === "[SENSITIVE]") continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

type Options = {
  coins: number;
  count: number;
  expiresDays: number;
  prefix: string;
  name?: string;
  envFile?: string;
  baseUrl?: string;
  dryRun: boolean;
  json: boolean;
};

const USAGE = `用法：npx tsx tools/issue-promo-code.ts [选项]

  --coins <n>        每张码的面额（站上单位＝币），预设 30
  --count <n>        一次发几张（1-100），预设 1
  --expires <days>   有效天数，预设 0＝永不过期
  --prefix <str>     码名前缀，预设 PROMO（仅供闸道后台辨识，用户看不到）
  --name <str>       指定完整码名（仅 --count 1 可用；重名会被上游拒绝）
  --env-file <path>  指定凭证档
  --base-url <url>   覆写闸道位址（预设 GATEWAY_BASE_URL 或生产位址）
  --dry-run          只印出将送出的请求，不真的发码
  --json             以 JSON 输出（方便脚本再加工）
  -h, --help         显示本说明`;

function fail(message: string): never {
  console.error(`错误：${message}`);
  console.error("");
  console.error(USAGE);
  process.exit(1);
}

function parseNumber(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`${flag} 必须是正数，收到「${raw}」`);
  return value;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    coins: 30,
    count: 1,
    expiresDays: 0,
    prefix: "PROMO",
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`${arg} 缺少值`);
      i += 1;
      return value;
    };

    switch (arg) {
      case "--coins":
        options.coins = parseNumber(next(), "--coins", 30);
        break;
      case "--count":
        options.count = Math.floor(parseNumber(next(), "--count", 1));
        break;
      case "--expires":
        options.expiresDays = Number(next());
        if (!Number.isFinite(options.expiresDays) || options.expiresDays < 0) {
          fail(`--expires 必须是 >= 0 的天数，收到「${argv[i]}」`);
        }
        break;
      case "--prefix":
        options.prefix = next();
        break;
      case "--name":
        options.name = next();
        break;
      case "--env-file":
        options.envFile = next();
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`未知参数「${arg}」`);
    }
  }

  if (options.count > 100) fail("--count 最多 100（要更多就多跑几次）");
  if (options.name && options.count !== 1) fail("--name 只能搭配 --count 1");
  if (!options.name && !/^[A-Za-z0-9_-]+$/.test(options.prefix)) {
    fail("--prefix 只允许英数、底线与连字号（上游后台搜寻用）");
  }
  // 只挡「会被帐本误判成营收」的那一种前缀，不是挡关键字。
  if (/^MP[A-Z0-9]{6,}$/i.test(options.name ?? options.prefix)) {
    fail("码名不可长成 mPay 订单格式（MP…），否则帐本会把它记成营收");
  }
  return options;
}

function gatewayBaseUrl(options: Options): string {
  return (
    options.baseUrl ??
    process.env.GATEWAY_BASE_URL ??
    "https://store.tinchak0207.xyz/newapi"
  );
}

function adminHeaders(): Record<string, string> {
  const token =
    process.env.GATEWAY_ADMIN_ACCESS_TOKEN ??
    process.env.GATEWAY_ADMIN_TOKEN ??
    process.env.NEW_API_ADMIN_ACCESS_TOKEN ??
    "";
  const userId = process.env.GATEWAY_ADMIN_USER_ID ?? process.env.NEW_API_ADMIN_USER_ID ?? "";

  if (!token.trim() || !userId.trim()) {
    console.error("缺少闸道管理凭证 GATEWAY_ADMIN_ACCESS_TOKEN / GATEWAY_ADMIN_USER_ID。");
    console.error("先 `vercel env pull .env.production.local`，或用 --env-file 指定凭证档。");
    process.exit(1);
  }

  return {
    Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "").trim()}`,
    "Content-Type": "application/json",
    "New-Api-User": userId.trim(),
  };
}

function buildName(options: Options): string {
  if (options.name) return withLengthGuard(options.name);
  // 上游对 `name` 有 20 字上限（现场实锤：22 字回「兑换码名称长度必须在1-20之间」）。
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return withLengthGuard(`${options.prefix}-${options.coins}-${suffix}`);
}

/** 码名长度上限由上游决定（1-20）；在地先挡，免得送出去才被拒。 */
function withLengthGuard(name: string): string {
  if (name.length < 1 || name.length > 20) {
    fail(`码名「${name}」长度 ${name.length} 超出自 1-20（上游限制）：缩短 --prefix 或 --name`);
  }
  return name;
}

type GatewayResult<T> = { success: boolean; message?: string; data?: T };

async function readGatewayResult<T>(response: Response): Promise<GatewayResult<T>> {
  const text = await response.text();
  if (!text) return { success: false, message: `闸道回 ${response.status}` };
  try {
    return JSON.parse(text) as GatewayResult<T>;
  } catch {
    return { success: false, message: text.slice(0, 300) };
  }
}

/** 发码核心：一张码一次 POST（与生产履约同一端点、同一请求形状）。 */
async function createCode(
  input: { name: string; quota: number; expiresDays: number },
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string> {
  const expiredTime = input.expiresDays > 0 ? Math.floor(Date.now() / 1000) + input.expiresDays * 86_400 : 0;
  const response = await fetch(`${baseUrl}/api/redemption/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: input.name,
      count: 1,
      quota: input.quota,
      expired_time: expiredTime,
    }),
    cache: "no-store",
  });
  const result = await readGatewayResult<string[]>(response);
  const key = result.data?.[0];
  if (!response.ok || !result.success || !key) {
    throw new Error(`${input.name}：${result.message ?? `闸道回 ${response.status}`}`);
  }
  return key;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.envFile) loadEnvFile(options.envFile);
  for (const file of [".env.production", ".env.production.local", ".env.local", ".env.pulled"]) {
    loadEnvFile(file);
  }

  const quota = Math.round(options.coins * QUOTA_PER_COIN);
  const baseUrl = gatewayBaseUrl(options);

  if (options.dryRun) {
    const request = {
      url: `${baseUrl}/api/redemption/`,
      method: "POST",
      body: {
        name: `${options.name ?? `${options.prefix}-${options.coins}-XXXXXX`}（--count ${options.count}）`,
        count: 1,
        quota,
        expired_time:
          options.expiresDays > 0
            ? Math.floor(Date.now() / 1000) + options.expiresDays * 86_400
            : 0,
      },
      note: `${options.coins} 币 = ${quota} quota = ${Math.round(options.coins * 0.045 * 100) / 100} 元等值`,
    };
    console.log(options.json ? JSON.stringify(request, null, 2) : JSON.stringify(request));
    return;
  }

  const headers = adminHeaders();
  const codes: { key: string; name: string }[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const name = buildName(options);
    try {
      codes.push({ key: await createCode({ name, quota, expiresDays: options.expiresDays }, baseUrl, headers), name });
    } catch (error) {
      // 已发出的码不再收回（上游没有撤销惯例）：如实印出，让操作者自己处置。
      if (codes.length) {
        console.error(`已发出 ${codes.length} 张，第 ${i + 1} 张失败。`);
        for (const code of codes) console.error(`  ${code.key}  (${code.name})`);
      }
      throw error;
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          coins: options.coins,
          quota,
          expiresDays: options.expiresDays,
          gateway: baseUrl,
          codes: codes.map((code) => ({ code: code.key, name: code.name })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // 兑换码本身就是 stdout 的主菜（给人复制去发），其余资讯走 stderr。
  for (const code of codes) console.log(code.key);
  console.error(
    `已发出 ${codes.length} 张：${options.coins} 币/张（= ${quota.toLocaleString("en-US")} quota` +
      `${options.expiresDays > 0 ? `，${options.expiresDays} 天后过期` : "，永不过期"}）`,
  );
  console.error(`兑换入口：${(process.env.NEXT_PUBLIC_SITE_URL ?? "https://eimu.dev").replace(/\/$/, "")}/pricing#redeem`);
}

// 不用 top-level await：本 repo 的 package.json 不是 ESM（tsx 会走 cjs 转译）。
main().catch((error: unknown) => {
  console.error(`发码失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
