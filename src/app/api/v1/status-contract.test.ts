import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const QUEUE = "src/app/api/v1/queue/route.ts";
const HISTORY = "src/app/api/v1/history/route.ts";
const SYSTEM_STATS = "src/app/api/v1/system_stats/route.ts";
const OBJECT_INFO = "src/app/api/v1/object_info/route.ts";
const STATUS_QUERY = "src/lib/generation-core/status-query.ts";
const ROUTES = [QUEUE, HISTORY, SYSTEM_STATS, OBJECT_INFO];

// ─────────────────────────────────────────── 认证与追踪

test("状态面端点只认 Authorization，不依赖任何自定义请求头", () => {
  for (const relPath of ROUTES) {
    const source = code(relPath);
    assert.match(source, /readBearerToken\(req\.headers\.get\("authorization"\)\)/, `${relPath} 必须从 Authorization 取令牌`);
    assert.match(source, /authenticateBizApiKey/, `${relPath} 必须校验 B 端密钥`);
    assert.match(source, /withTraceId/, `${relPath} 必须带 trace_id`);
    assert.doesNotMatch(source, /x-user-id/, `${relPath} 不得依赖 x-user-id`);
    assert.doesNotMatch(source, /getStoredUserFromHeaders/, `${relPath} 不得使用未校验的请求头身份`);
  }
});

test("状态面端点是只读端点，认证时不消费限流名额", () => {
  for (const relPath of ROUTES) {
    assert.match(code(relPath), /consumeRateLimit:\s*false/, `${relPath} 不应在读取时消费限流名额`);
  }
});

// ─────────────────────────────────────────── tenant 隔离

test("queue / history 必须限定为该密钥自己的 tenant", () => {
  for (const relPath of [QUEUE, HISTORY]) {
    const source = code(relPath);
    assert.match(source, /bizTenantId\(auth\.key\.id\)/, `${relPath} 必须用密钥记录构造 tenant`);
    assert.doesNotMatch(source, /tenant.*body|body.*tenant/, `${relPath} 不得接受请求体指定 tenant`);
  }
  // tenant 前缀与提交路径同源（images/generations 提交时用 biz:<keyId>）。
  const generations = code("src/app/api/v1/images/generations/route.ts");
  assert.match(generations, /tenantId:\s*`biz:\$\{apiKey\.id\}`/, "提交路径必须用同一 biz: 前缀");
});

test("status-query 的队列查询强制 status + tenant 双重过滤", () => {
  const source = code(STATUS_QUERY);
  assert.match(source, /WHERE tenant_id = \$\{tenantId\}/, "队列查询必须带 tenant 过滤");
  assert.match(source, /status = ANY\(\$\{QUEUE_STATUSES\}::text\[\]\)/, "队列查询必须限定活跃状态集");
  assert.ok(
    code("src/lib/generation-core/task-response.ts"),
    "活跃状态集应只含未终结状态（succeeded/failed/cancelled/refunded 不在 QUEUE）",
  );
});

test("queue 的活跃状态集定义在 status-query，且不含终结状态", () => {
  const source = code(STATUS_QUERY);
  for (const active of ["pending_billing", "queued", "leased", "submitting", "running", "submit_unknown"]) {
    assert.match(source, new RegExp(`"${active}"`), `活跃状态集应包含 ${active}`);
  }
  for (const terminal of ["succeeded", "failed", "cancelled", "refunded"]) {
    const list = /QUEUE_STATUSES\s*:\s*readonly GenerationJobStatus\[\]\s*=\s*\[([\s\S]*?)\];/.exec(code(STATUS_QUERY));
    assert.ok(list, "应能定位 QUEUE_STATUSES 列表");
    assert.doesNotMatch(list[1], new RegExp(`"${terminal}"`), `${terminal} 是终结状态，不应出现在队列`);
  }
});

// ─────────────────────────────────────────── history 分页

test("history 必须从 URL 解析 limit/offset 并回传分页元数据", () => {
  const source = code(HISTORY);
  assert.match(source, /url\.searchParams\.get\("limit"\)/, "limit 必须来自查询串");
  assert.match(source, /url\.searchParams\.get\("offset"\)/, "offset 必须来自查询串");
  assert.match(source, /clampPagination\(/, "分页必须收敛到白名单区间");
  assert.match(source, /data,\s*limit,\s*offset,\s*total:\s*result\.total,\s*has_more:\s*hasMore/, "响应必须带分页元数据");
  assert.match(source, /const hasMore = offset \+ data\.length < result\.total;/, "has_more 必须按总数判定");
});

test("history 的查询必须走 status-query 的 tenant 隔离函数，不裸拼 SQL", () => {
  const source = code(HISTORY);
  assert.match(source, /listTenantHistory\(/, "必须复用 tenant 隔离的历史查询");
  assert.match(source, /countTenantJobs\(/, "总数查询必须同样带 tenant 过滤");
  assert.doesNotMatch(source, /generation_job/, "路由文件内不得出现裸表名");
});

// ─────────────────────────────────────────── system_stats 聚合诚实性

test("system_stats 的 SQL 只做聚合，不选任何 per-tenant 字段", () => {
  const source = code(STATUS_QUERY);
  assert.match(source, /WHERE source = 'biz'/, "统计必须限定 biz 轨道");
  assert.match(source, /GROUP BY model_id/, "聚合维度只能是模型");
  const aggregate = /queryPlatformDigest[\s\S]*?FROM generation_job[\s\S]*?(?:\n}|;)/.exec(source);
  assert.ok(aggregate, "应能定位平台聚合函数");
  assert.doesNotMatch(aggregate[0], /tenant_id/, "聚合查询不得选中 tenant_id");
  assert.doesNotMatch(aggregate[0], /api_key_id/, "聚合查询不得选中 api_key_id");
});

test("system_stats 成功率语义与 SLO 一致：不含排队的（不灌水）", () => {
  const query = code(STATUS_QUERY);
  assert.match(query, /success_rate:\s*terminal\s*>\s*0\s*\?\s*succeeded\s*\/\s*terminal\s*:\s*null/, "成功率必须只按成功+失败算");
  const route = code(SYSTEM_STATS);
  assert.match(route, /object:\s*"system_stats"/, "响应必须是 system_stats 对象");
  assert.match(route, /computePlatformStats/, "路由必须消费纯函数消化聚合");
});

test("system_stats 的路由不接触 job 明细，只回聚合", () => {
  const source = code(SYSTEM_STATS);
  assert.doesNotMatch(source, /mapGenerationJob|generation_job/, "路由不应拉取 job 明细");
  assert.match(source, /queryPlatformDigest/, "必须走平台聚合查询");
});

// ─────────────────────────────────────────── object_info 能力面

test("object_info 复用 /v1/models 同源目录，且只列该密钥有权的模型", () => {
  const source = code(OBJECT_INFO);
  assert.match(source, /SUPPORTED_GENERATION_MODEL_IDS/, "必须遍历图像+视频全集");
  assert.match(source, /isModelAllowedForKey\(auth\.key, modelId\)/, "必须过滤密钥模型白名单");
  assert.match(source, /generationCapabilities\(modelId\)/, "能力必须来自目录投影");
});

test("object_info 必须文档化参数契约与认证方式", () => {
  const source = code(OBJECT_INFO);
  assert.match(source, /authentication:/, "必须说明认证方式");
  assert.match(source, /"sk-biz-…"/, "必须指出密钥前缀");
  assert.match(source, /"prompt"/, "必须文档化 prompt 参数");
  assert.match(source, /"model"/, "必须文档化 model 参数");
  assert.match(source, /"callback_url"/, "必须文档化 callback_url（outbox 交付）");
});

// ─────────────────────────────────────────── 错误面

test("状态面端点错误体保留 OpenAI 必填字段 + trace_id", () => {
  for (const relPath of ROUTES) {
    const source = code(relPath);
    assert.match(
      source,
      /error:\s*\{\s*message,\s*type:\s*"invalid_request_error",\s*code,\s*param:\s*null,\s*trace_id:\s*traceId\s*\}/,
      `${relPath} 错误体必须带 OpenAI 形状 + trace_id`,
    );
    assert.match(source, /withTraceId\(response,\s*traceId\)/, `${relPath} 必须把 trace_id 写进 X-Request-Id`);
  }
});

test("history 对非法 status 过滤参数回 invalid_status，而不是静默忽略", () => {
  const source = code(HISTORY);
  assert.match(source, /"invalid_status"/, "非法 status 必须显式报错");
  assert.match(source, /HISTORY_STATUSES\.join\("、"\)/, "报错时必须列出合法值");
});

test("DB 未配置时诊断面诚实返回空/零，而不是假 500", () => {
  const query = code(STATUS_QUERY);
  assert.match(query, /queryWhenReady/, "必须共用 DB 未配置的优雅降级");
  assert.match(query, /isControlPlaneUnavailableError/, "必须识别控制面未配置错误");
  for (const relPath of [QUEUE, HISTORY, SYSTEM_STATS]) {
    assert.match(code(relPath), /queryWhenReady/, `${relPath} 必须走 queryWhenReady`);
  }
});
