import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CONTROL_PLANE_PROXY_SOURCES as ProxySources } from "../../../../lib/control-plane-proxy-routes.mjs";

// 代理清單真源是 .mjs（next.config.mjs 在建置期直接 import 它）。本檔跑在
// tsx 的 CJS 模式下，靜態 import 相對路徑的 .mjs 會被包成 require 並解析失敗
// （require 相對 .mjs 只認 .js）；靜態 import type 可以（型別不進執行期）。
// 故執行期用 pathToFileURL 產生絕對 file:// URL 後動態 import。
type ControlPlaneRewrite = { source: string; destination: string };
let proxyModule: {
  CONTROL_PLANE_PROXY_SOURCES: string[];
  controlPlaneRewrites: (origin?: string | null) => ControlPlaneRewrite[];
};
async function loadProxyRoutes() {
  if (!proxyModule) {
    proxyModule = (await import(pathToFileURL(join(root, "src/lib/control-plane-proxy-routes.mjs")).href)) as typeof proxyModule;
  }
  return proxyModule;
}
/** 用不到的執行期值，只為讓上面的型別匯入不成為孤兒（避免 noUnusedLocals 類規則失火）。 */
type _ProxySources = typeof ProxySources;

const root = process.cwd();

function read(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}

/** 去掉注释后再断言，避免注释里引用的反例把测试带跑。 */
function code(relPath: string) {
  return read(relPath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const GENERATIONS = "src/app/api/v1/images/generations/route.ts";
const MODELS = "src/app/api/v1/models/route.ts";

// ─────────────────────────────────────────── 认证

test("B 端端点只认 Authorization，不依赖任何自定义请求头", () => {
  // 聚合平台不会替我们转发 x-user-id —— 一旦端点依赖它，接入方永远调不通。
  for (const relPath of [GENERATIONS, MODELS]) {
    const source = code(relPath);
    assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/, `${relPath} 必须从 Authorization 取令牌`);
    assert.match(source, /authenticateBizApiKey/, `${relPath} 必须校验 B 端密钥`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得依赖 x-user-id`);
    assert.doesNotMatch(source, /getStoredUserFromHeaders/, `${relPath} 不得使用未校验的请求头身份`);
  }
});

test("计费主体只来自密钥记录，不来自请求体", () => {
  const source = code(GENERATIONS);
  assert.match(source, /apiKey\.userId/, "扣费用户必须取自密钥记录");
  assert.doesNotMatch(source, /body\.userId|body\.user_id/, "不得从请求体取计费用户");
});

test("持久化的记录结构里没有明文密钥字段", () => {
  // 只看 BizApiKey 接口本体 —— 函数参数叫 rawKey 是正常的，那不落盘。
  const types = read("src/lib/biz-api-keys.ts");
  const iface = /export interface BizApiKey \{([\s\S]*?)\n\}/.exec(types);
  assert.ok(iface, "应能定位 BizApiKey 接口");

  assert.match(iface[1], /keyHash: string/, "只存哈希");
  assert.match(iface[1], /keyPreview: string/, "存一个不可反推的展示片段");
  for (const forbidden of [/\bkey:\s*string/, /plaintext/i, /secret/i]) {
    assert.doesNotMatch(iface[1], forbidden, "记录结构不得含明文密钥");
  }
});

test("明文密钥只在签发响应里出现一次，列表接口永不返回哈希", () => {
  const admin = code("src/app/api/admin/biz-keys/route.ts");
  // 签发时返回明文
  assert.match(admin, /key:\s*issued\.key/);
  // 列表与详情一律走 toPublicBizApiKey，它会摘掉 keyHash
  assert.match(admin, /toPublicBizApiKey/);
  assert.doesNotMatch(admin, /data:\s*keys(?!\.map)/, "列表不得直接把原始记录发出去");

  const types = read("src/lib/biz-api-keys.ts");
  assert.match(types, /Omit<BizApiKey,\s*"keyHash">/, "公开视图必须摘掉 keyHash");
});

test("管理端点全部要求管理员会话", () => {
  for (const relPath of ["src/app/api/admin/biz-keys/route.ts", "src/app/api/admin/biz-keys/[id]/route.ts"]) {
    const source = code(relPath);
    const handlers = source.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    assert.ok(handlers.length > 0, `${relPath} 应当导出处理函数`);
    // 每个 handler 都要有一次 requireAdminSession
    const guards = source.match(/requireAdminSession\(\)/g) ?? [];
    assert.equal(guards.length, handlers.length, `${relPath} 的每个 handler 都必须校验管理员会话`);
  }
});

// ─────────────────────────────────────────── 计费正确性

test("失败时把未出图的配额退回，且退款不阻塞响应", () => {
  const source = code(GENERATIONS);
  assert.match(source, /reserveImageQuota\(apiKey\.userId/, "必须先预留配额");
  assert.match(source, /refundImageQuota\(apiKey\.userId,\s*unusedQuota\)/, "未用完的配额必须退回");
  // 退款放在 after() 里：既不拖慢响应，也不会因为退款失败而把已成功的图吞掉
  assert.match(source, /after\(\s*\(\)\s*=>\s*\n?\s*refundImageQuota/, "退款应在 after() 中执行");
  assert.match(source, /unusedQuota\s*=\s*coinsPerImage\s*\*\s*QUOTA_PER_COIN\s*\*\s*\(rawN\s*-\s*delivered\)/);
});

test("预留的配额按 n 张计算，不是按一张", () => {
  const source = code(GENERATIONS);
  assert.match(source, /totalQuota\s*=\s*coinsPerImage\s*\*\s*QUOTA_PER_COIN\s*\*\s*rawN/);
});

test("配额换算复用同一个常量来源", () => {
  const source = code(GENERATIONS);
  assert.match(source, /from "@\/lib\/quota-constants"/);
  assert.doesNotMatch(source, /500_000|500000/, "不得再写一份魔数");
});

// ─────────────────────────────────────────── 输入校验

test("生图端点对每个入参都有上限或白名单", () => {
  const source = code(GENERATIONS);
  assert.match(source, /MAX_PROMPT_LENGTH/, "prompt 必须有长度上限");
  assert.match(source, /SUPPORTED_SIZES\.has\(size\)/, "size 必须走白名单");
  assert.match(source, /isSupportedImageModel\(modelId\)/, "model 必须走白名单");
  assert.match(source, /rawN < 1 \|\| rawN > MAX_N/, "n 必须有区间限制");
  assert.match(source, /isModelAllowedForKey/, "必须校验密钥的模型白名单");
});

// ─────────────────────────────────────────── OpenAI 兼容性

test("错误体保留 OpenAI 必填字段，同时允许 trace_id 扩展", () => {
  const source = code(GENERATIONS);
  assert.match(source, /error:\s*\{\s*message,\s*type,\s*code,\s*param:\s*null(?:,\s*trace_id:\s*traceId)?\s*\}/);
});

test("成功响应是 OpenAI 形状：created + data 数组", () => {
  const source = code(GENERATIONS);
  assert.match(source, /created:\s*Math\.floor\(Date\.now\(\)\s*\/\s*1000\)/);
  assert.match(source, /data:\s*images/);
});

test("响应格式同时支持 b64_json 与 url", () => {
  const source = code(GENERATIONS);
  assert.match(source, /response_format/);
  assert.match(source, /b64_json/);
  assert.match(source, /url:\s*imageUrl/);
});

test("hd / high 映射到内部的 quality 档", () => {
  const source = code(GENERATIONS);
  assert.match(source, /body\.quality === "hd" \|\| body\.quality === "high"/);
});

test("/v1/models 返回 OpenAI 的 list 结构，且只列该密钥有权的模型", () => {
  const source = code(MODELS);
  assert.match(source, /object:\s*"list"/);
  assert.match(source, /object:\s*"model"/);
  assert.match(source, /owned_by/);
  assert.match(source, /isModelAllowedForKey\(auth\.key, modelId\)/);
});

test("/v1/models 必须同时列出视频模型，否则聚合平台永远发现不了视频能力", () => {
  // 曾经这里只遍历 SUPPORTED_IMAGE_MODEL_IDS，导致 /v1/videos/generations 明明能收单
  // （202 queued），但 /v1/models 报 video-capable: 0，平台侧无从上架。
  const source = code(MODELS);
  assert.match(source, /SUPPORTED_GENERATION_MODEL_IDS/, "必须遍历图像 + 视频的全集");
  assert.doesNotMatch(
    source,
    /SUPPORTED_IMAGE_MODEL_IDS\b/,
    "不得只遍历图像全集（视频模型会整批消失）",
  );
  assert.match(source, /x_endpoint/, "混表必须指出投递端点");
  assert.match(source, /"\/v1\/videos\/generations"/, "视频模型的端点必须是 /v1/videos/generations");
});

test("视频单价按秒给，且与扣费同源（generationCoins）", () => {
  const source = code(MODELS);
  assert.match(source, /x_coins_per_second/, "视频必须给每秒单价");
  assert.match(source, /generationCoins\(/, "报价必须走扣费同一个函数，不得另立一份价表");
  assert.match(source, /durationSeconds:\s*1/, "每秒单价 = durationSeconds 取 1");
});

test("/v1/models 报价前先同步 admin 覆写，避免报旧价扣新价", () => {
  // 所有扣费路由都 syncModelPricing()；列表若不同步，改价后会出现
  // 「/v1/models 说 A 元、实际扣 B 元」的不诚实差异。
  assert.match(code(MODELS), /await syncModelPricing\(\)/);
});

test("openapi 的 ModelObject 不得把 x_coins_per_image 列为必填", () => {
  // 视频模型没有这个字段，列必填会让严格校验的客户端把整张表判为不合规。
  const source = read("src/app/api/v1/openapi.json/route.ts");
  const block = source.slice(source.indexOf("ModelObject:"), source.indexOf("ModelList:"));
  assert.doesNotMatch(block, /required: \[[^\]]*"x_coins_per_image"/);
  assert.match(block, /x_coins_per_second/, "契约必须描述视频的按秒单价");
});

test("限流被拒时带上 Retry-After，客户端才知道等多久", () => {
  for (const relPath of [GENERATIONS, MODELS]) {
    assert.match(code(relPath), /"Retry-After"/, `${relPath} 应返回 Retry-After`);
  }
});

// ─────────────────────────────────────────── 与 C 端主链路的一致性

test("B 端管线的预算常量与 /api/generate-images 保持一致，冷却直接同源", () => {
  // 预算常量仍各持一份字面量（各自的循环真在用），数值必须钉死一致；
  // 冷却/熔断则升级为「同一个模块」——channel-registry 里只有一份 Map，
  // 一条管线撞到的坏端点另一条不必再撞，比数值一致更强。
  const pipeline = read("src/lib/biz-image-pipeline.ts");
  const mainRoute = read("src/app/api/generate-images/route.ts");

  const pairs: Array<[string, string]> = [
    ["BIZ_UPSTREAM_BUDGET_MS", "UPSTREAM_BUDGET_MS"],
    ["BIZ_MIN_ATTEMPT_BUDGET_MS", "MIN_ATTEMPT_BUDGET_MS"],
  ];

  for (const [bizName, mainName] of pairs) {
    const biz = new RegExp(`${bizName}\\s*=\\s*([0-9_]+)`).exec(pipeline);
    const main = new RegExp(`\\b${mainName}\\s*=\\s*([0-9_]+)`).exec(mainRoute);
    assert.ok(biz, `biz-image-pipeline.ts 应定义 ${bizName}`);
    assert.ok(main, `generate-images/route.ts 应定义 ${mainName}`);
    assert.equal(
      Number(biz[1].replace(/_/g, "")),
      Number(main[1].replace(/_/g, "")),
      `${bizName} 与 ${mainName} 必须一致，否则两条链路的故障转移行为会分叉`,
    );
  }

  // 熔断同源：两个文件都必须从 channel-registry 引入同一份实现，
  // 谁在本地重新养一份 Map 谁就在制造「两条链路各自为战」的回归。
  for (const [name, source] of [["biz-image-pipeline.ts", pipeline], ["generate-images/route.ts", mainRoute]] as const) {
    assert.match(source, /from "(?:@\/lib\/|\.\/)channel-registry"/, `${name} 必须从 channel-registry 取熔断`);
  }
  const registry = read("src/lib/channel-registry.ts");
  assert.match(registry, /ENDPOINT_FAILURE_THRESHOLD = 2/);
  assert.match(registry, /ENDPOINT_COOLDOWN_MS = 60_000/);
});

test("B 端管线与主链路同源取队列，而不是自己另写一套", () => {
  const pipeline = code("src/lib/biz-image-pipeline.ts");
  // buildModelQueue 是唯一队列入口（含 /admin overrides）；
  // 直接调 buildGatewayEndpointsWithPools 会绕过 admin 的启停与优先级覆写。
  assert.match(pipeline, /buildModelQueue/, "必须与 /admin 路由调度面板同源");
  assert.match(pipeline, /getRuntimeChannelOverrides/, "必须尊重 admin 的渠道覆写");
  assert.match(pipeline, /getRuntimeGatewayPools/);
  assert.match(pipeline, /resolveUpstreamModelId/, "必须复用模型 id 映射");
  assert.doesNotMatch(pipeline, /buildGatewayEndpointsWithPools/, "不得绕过 registry 直拼队列");
});

test("B 端不碰历史记录，避免把商用调用混进 C 端用户的作品库", () => {
  const source = code(GENERATIONS);
  assert.doesNotMatch(source, /saveGeneratedHistoryEntry/);
});

test("/v1 对外路径通过重写指向 /api/v1，客户填的 Base URL 不带 /api", () => {
  // OpenAI SDK 会在 baseURL 后拼 `/images/generations`，
  // 所以 Base URL 必须是 `…/v1` 而不是 `…/api/v1`。
  const config = read("next.config.mjs");
  assert.match(config, /async rewrites\(\)/);
  assert.match(config, /source:\s*"\/v1\/:path\*"/);
  assert.match(config, /destination:\s*"\/api\/v1\/:path\*"/);

  // 文档里给客户的 Base URL 必须与重写规则一致
  const doc = read("docs/biz-api.md");
  assert.match(doc, /https:\/\/eimu\.dev\/v1/);
  assert.doesNotMatch(doc, /eimu\.dev\/api\/v1/, "对外文档不应暴露 /api/v1");
});

test("代理到控制面的端點必須同時覆蓋裸路徑與子路徑", async () => {
  // `/:path*` 匹配不到「後面沒有任何一段」的裸路徑。前端打的是
  // `POST /api/generation-jobs`（無子路徑），只寫 `/api/generation-jobs/:path*`
  // 會讓它落在 Vercel，而 Vercel 沒有 GENERATION_CONTROL_PLANE_ENABLED /
  // GENERATION_DATABASE_URL，於是回 503 control_plane_disabled，前端退回舊路徑、
  // 拿到上游直鏈導致瀏覽器 ERR_CONNECTION_CLOSED。裸路徑要單獨寫一條。
  //
  // 斷言對象是代理清單的單一真源（`control-plane-proxy-routes.mjs`）的真實輸出，
  // 不是 next.config.mjs 的文字：2026-09-28 起該檔只是呼叫 `controlPlaneRewrites()`，
  // 清單本身不再以字面出現在 next.config.mjs，讀文字會永遠抓不到。
  // 清單的逐條全量相等由 src/lib/control-plane-proxy-routes.test.ts 守；這裡只守
  // 「裸路徑 vs 子路徑」這一格。
  const origin = "https://o.example";
  const { CONTROL_PLANE_PROXY_SOURCES, controlPlaneRewrites } = await loadProxyRoutes();
  const rewrites = controlPlaneRewrites(origin);
  for (const base of ["/api/generation-jobs"]) {
    assert.ok(
      CONTROL_PLANE_PROXY_SOURCES.includes(base),
      `${base} 缺精確匹配的 rewrite，裸路徑會落在 Vercel 回 503`,
    );
    assert.ok(
      CONTROL_PLANE_PROXY_SOURCES.includes(`${base}/:path*`),
      `${base} 缺子路徑 rewrite`,
    );

    // destination 也必須原樣把路徑接在控面 origin 之後（控面在 /image-control
    // 前綴下服務同一組路徑）。只驗 source 抓不到 destination 被寫壞。
    assert.equal(
      rewrites.find((r) => r.source === base)?.destination,
      `${origin}/image-control${base}`,
      `${base} 的 destination 必須原樣接到控面 origin 之後`,
    );
    assert.equal(
      rewrites.find((r) => r.source === `${base}/:path*`)?.destination,
      `${origin}/image-control${base}/:path*`,
      `${base}/:path* 的 destination 必須原樣接到控面 origin 之後`,
    );
  }
});

test("控制面代理必須位於 beforeFiles，否則同名 route.ts 會讓它整條失效", async () => {
  // 這是上一條測試沒抓到的更深一層：即使兩條 rewrite 都寫齊，只要它們待在
  // `rewrites()` 的回傳陣列裡（語意等同 afterFiles），Next.js 就會先比對檔案系統
  // 路由並命中 src/app/api/generation-jobs/route.ts，代理永遠不會觸發。
  // /v1/:path* 當時看起來正常只是因為 repo 裡沒有 src/app/v1 目錄。
  process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN = "https://example.invalid";
  const { default: config } = await import("../../../../next.config.mjs");
  const rewrites = await config.rewrites();

  assert.ok(!Array.isArray(rewrites), "rewrites() 不能回傳陣列——陣列等同 afterFiles");
  assert.ok(Array.isArray(rewrites.beforeFiles), "必須有 beforeFiles 分組");

  const before = rewrites.beforeFiles.map((r: { source: string }) => r.source);
  // 每個「本地存在同名 route.ts」的代理端點都必須在 beforeFiles 裡。
  for (const source of ["/api/generate-images", "/api/generation-jobs", "/api/generation-jobs/:path*"]) {
    assert.ok(before.includes(source), `${source} 必須在 beforeFiles，否則被本地 route 攔截`);
  }
});

// ─────────────────────────────────────────── 开户端点

test("开户端点要求管理员会话，且不把上游凭证发给客户端", () => {
  const source = code("src/app/api/admin/biz-keys/provision/route.ts");
  const handlers = source.match(/export async function (GET|POST)/g) ?? [];
  const guards = source.match(/requireAdminSession\(\)/g) ?? [];
  assert.equal(guards.length, handlers.length, "每个 handler 都必须校验管理员会话");

  // 上游管理凭证只能留在服务端。
  assert.doesNotMatch(source, /GATEWAY_ADMIN_ACCESS_TOKEN/, "路由不该直接接触凭证，交给 gateway-admin");
  const admin = code("src/lib/gateway-admin.ts");
  assert.doesNotMatch(admin, /"use client"/, "gateway-admin 必须是服务端模块");
});

test("开户对额度与用户名都有上限和白名单，防手滑多打一个零", () => {
  const source = code("src/app/api/admin/biz-keys/provision/route.ts");
  assert.match(source, /MAX_INITIAL_IMAGES/);
  assert.match(source, /USERNAME_PATTERN\.test\(username\)/);
});

test("开户是幂等的：同名账户复用而不是重复创建", () => {
  const admin = code("src/lib/gateway-admin.ts");
  assert.match(admin, /findGatewayUserByUsername/);
  assert.match(admin, /if \(existing\)/, "已存在时应复用");
});

test("查用户名做精确比对，避免前缀误命中", () => {
  // New API 的 search 只做关键词匹配，`biz-a` 会命中 `biz-abc`。
  const admin = code("src/lib/gateway-admin.ts");
  assert.match(admin, /items\.find\(\(user\) => user\.username === username\)/);
});

test("额度调整复用生产扣费同一个上游端点与参数", () => {
  const admin = code("src/lib/gateway-admin.ts");
  const billing = code("src/lib/image-billing.ts");
  for (const source of [admin, billing]) {
    assert.match(source, /\/api\/user\/manage/);
    assert.match(source, /action:\s*"add_quota"/);
  }
  // 换算常量必须来自同一处
  assert.match(admin, /from "\.\/quota-constants"/);
});

test("签发界面在绑定前会显示计费账户余额", () => {
  // 绑到空账户上，第一次调用就是 402，聚合平台会以为密钥是坏的。
  const ui = code("src/components/admin/AdminBizKeys.tsx");
  assert.match(ui, /checkBalance/);
  assert.match(ui, /biz-keys\/provision\?userId=/);
  assert.match(ui, /402/, "余额为 0 时应明确提示会返回 402");
});

test("开户用的字段长度限制与上游 New API 的 validate 标签一致", () => {
  // 生产事故：随机密码用了 randomBytes(16).toString("base64url") = 22 个字符，
  // 超过上游 max=20，签发时报「输入不合法 Key: 'User.Password' ... on the 'max' tag」。
  // 这些数字必须跟着上游走，所以直接从 vendored 源码里读出来比对。
  let model: string;
  try {
    model = read("tmp/new-api-src/model/user.go");
  } catch {
    // 没有 vendored 源码时跳过，不让本地环境差异把测试搞红。
    return;
  }

  const limits = {
    Username: /Username\s+string[^`]*`[^`]*validate:"max=(\d+)"/.exec(model),
    Password: /Password\s+string[^`]*`[^`]*validate:"min=(\d+),max=(\d+)"/.exec(model),
    DisplayName: /DisplayName\s+string[^`]*`[^`]*validate:"max=(\d+)"/.exec(model),
  };

  assert.ok(limits.Username && limits.Password && limits.DisplayName, "应能从上游源码解析出长度限制");

  const admin = read("src/lib/gateway-admin.ts");
  // 用字符串精确比对而不是拼正则：模板字面量里的 `\b` 会被解析成退格符而不是词边界，
  // 这个坑本身就让这条测试先假绿了一次。
  assert.ok(
    admin.includes(`GATEWAY_USERNAME_MAX_LENGTH = ${limits.Username[1]};`),
    `用户名上限应为 ${limits.Username[1]}`,
  );
  assert.ok(
    admin.includes(`GATEWAY_PASSWORD_MIN_LENGTH = ${limits.Password[1]};`),
    `密码下限应为 ${limits.Password[1]}`,
  );
  assert.ok(
    admin.includes(`GATEWAY_PASSWORD_MAX_LENGTH = ${limits.Password[2]};`),
    `密码上限应为 ${limits.Password[2]}`,
  );
  assert.ok(
    admin.includes(`GATEWAY_DISPLAY_NAME_MAX_LENGTH = ${limits.DisplayName[1]};`),
    `展示名上限应为 ${limits.DisplayName[1]}`,
  );

  // 生成的密码长度必须落在区间内。12 字节 base64url 恰好 16 个字符。
  const bytes = Number(/randomBytes\((\d+)\)\.toString\("base64url"\)/.exec(admin)?.[1]);
  assert.ok(Number.isInteger(bytes), "应能解析出随机密码的字节数");
  const generatedLength = Math.ceil((bytes * 4) / 3);
  assert.ok(
    generatedLength >= Number(limits.Password[1]) && generatedLength <= Number(limits.Password[2]),
    `randomBytes(${bytes}) 产出 ${generatedLength} 个字符，超出上游允许的 ${limits.Password[1]}–${limits.Password[2]}`,
  );

  // display_name 也不能超
  const displayName = /display_name:\s*"([^"]*)"/.exec(admin)?.[1] ?? "";
  assert.ok(
    [...displayName].length <= Number(limits.DisplayName[1]),
    `display_name「${displayName}」有 ${[...displayName].length} 个字符，超过上游上限 ${limits.DisplayName[1]}`,
  );

  // 路由的用户名正则不能放过超长的名字
  const route = read("src/app/api/admin/biz-keys/provision/route.ts");
  const quantifier = /USERNAME_PATTERN = \/\^\[a-z0-9\]\[a-z0-9_-\]\{\d+,(\d+)\}\$\//.exec(route);
  assert.ok(quantifier, "应能解析出用户名正则的长度上限");
  // 正则是「首字符 + 后续 {min,max}」，总长 = max + 1
  assert.equal(
    Number(quantifier[1]) + 1,
    Number(limits.Username[1]),
    `正则允许的总长度应为 ${limits.Username[1]}`,
  );
});
