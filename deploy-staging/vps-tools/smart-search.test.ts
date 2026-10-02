// smart_search 工具真值测试（smartsearch 免 Key 通路工具化）。
//
// 全部为**真行为断言**（不是源码字符串扫描）：
//   1. intent → 子命令映射：fixture 回显 sys.argv，断言 page/docs(带/不带 library_id)/web 的 argv 正确。
//   2. 逾时推导：page=60s / docs=60s / web=120s；慢 fixture → upstream_timeout（SIGKILL）。
//   3. 注入防护：query 含 `; rm -rf <哨兵>`，断言 fixture 收到**一个完整 argv 元素**、哨兵目录仍在
//      （未被 shell 解析执行）。
//   4. 子进程 env 白名单：EXA_API_KEY 透传、SECRET_TOKEN 不传、HOME/PYTHONPATH 已设。
//   5. 解析路径：合法 JSON 透传 / 非 JSON=bad_output / 非零退出=upstream_exit。
//   6. web intent 因缺 main-search 凭证回 ok:false 时 → 工具自动免 Key 回落 anysearch-search；
//      若两條都失败才 fail（hint 含两條错误 + search_web 替代指引）。
//   7. web 免 Key 回落真行为：search ok:false → 确实改跑 anysearch-search（fixture 回显被调用
//      子命令序列证明）；search ok:true → 只跑一次；剩余预算不足 → 如实回报不静默截断。
//   8. 真实 CLI 非零退出（config_error → exit 3）但 stdout 为合法 JSON ok:false → 仍据 JSON
//      判成敗并触发回落（不对 exit code 死板判死）。
//
// 跑法：bun test deploy-staging/vps-tools/smart-search.test.ts
//   或：bash deploy-staging/vps-tools/run-tests.sh ../vps-tools/smart-search.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"

import {
  SMART_SEARCH_HARNESS_TOOL_IDS,
  SMART_SEARCH_TIMEOUT_DOCS_MS,
  SMART_SEARCH_TIMEOUT_PAGE_MS,
  SMART_SEARCH_TIMEOUT_WEB_MS,
  resolveSubcommand,
  resolveTimeoutMs,
  runSmartSearchTool,
} from "../opencode-runtime/lib/smart_search_impl"

const FIX = mkdtempSync(join(tmpdir(), "smart-search-fixture-"))
const ENV_HOME = mkdtempSync(join(tmpdir(), "smart-search-home-"))
const SENTINEL = join(FIX, "injection-sentinel")

function writePy(name: string, body: string): string {
  const p = join(FIX, name)
  writeFileSync(p, body, "utf8")
  return p
}

// 以「模块名」注入 spawn（spawn 形状为 `python3 -m <module> <argv>`，PYTHONPATH 指向 FIX）。
const ARGV_ECHO = "argv_echo"
writePy(
  `${ARGV_ECHO}.py`,
  "import sys, json\nprint(json.dumps(sys.argv[1:], ensure_ascii=False))\n",
)

// 合法 JSON（page 抓取的假回包）。
const VALID = "valid_out"
writePy(
  `${VALID}.py`,
  "import sys, json\n" +
    "print(json.dumps({'ok': True, 'provider': 'jina', 'url': sys.argv[2], 'content': '# Example Domain'}, ensure_ascii=False))\n",
)

// web intent 缺 main-search 凭证：CLI 实际输出（ok:false + config_error，退出码 0）。
const MISSING = "missing_creds"
writePy(
  `${MISSING}.py`,
  "import json\n" +
    "print(json.dumps({'ok': False, 'error_type': 'config_error', 'error': 'The minimum profile requires at least one provider for each of main_search, docs_search, and web_fetch. Missing capabilities: main_search'}, ensure_ascii=False))\n",
)

// 非 JSON 输出。
const NOT_JSON = "notjson"
writePy(`${NOT_JSON}.py`, "print('this is not json')\n")

// 非零退出 + stderr。
const NONZERO = "nonzero"
writePy(`${NONZERO}.py`, "import sys\nsys.stderr.write('boom stderr detail')\nsys.exit(3)\n")

// 睡到被 SIGKILL。
const SLOW = "slow"
writePy(`${SLOW}.py`, "import time\ntime.sleep(30)\n")

// env 探针：只回键的存在性/值（不泄漏任何密钥值）。
const ENV_PROBE = "env_probe"
writePy(
  `${ENV_PROBE}.py`,
  "import os, json\n" +
    "print(json.dumps({'has_exa': 'EXA_API_KEY' in os.environ, " +
    "'has_secret': 'SECRET_TOKEN' in os.environ, " +
    "'home': os.environ.get('HOME', ''), " +
    "'pythonpath': os.environ.get('PYTHONPATH', '')}))\n",
)

// ── web 免 Key 回落探针：把「实际被调用的子命令 argv」逐条追加到 rec 文件 ──
// 断言「确实改跑了 anysearch-search」必须读这个 rec（真行为证据），不是只看最终输出。

/** web 回落探针：search → ok:false(config_error/main_search)；anysearch-search → ok:true。 */
const WEB_FALLBACK = "web_fallback_probe"
const REC_FALLBACK = join(FIX, "web_fallback.rec")
writePy(
  `${WEB_FALLBACK}.py`,
  "import sys, json\n" +
    `REC = ${JSON.stringify(REC_FALLBACK)}\n` +
    "args = sys.argv[1:]\n" +
    "open(REC, 'a').write(json.dumps(args, ensure_ascii=False) + '\\n')\n" +
    "sub = args[0] if args else ''\n" +
    "if sub == 'search':\n" +
    "    print(json.dumps({'ok': False, 'error_type': 'config_error', 'error': 'The minimum profile requires at least one provider for each of main_search, docs_search, and web_fetch. Missing capabilities: main_search'}, ensure_ascii=False))\n" +
    "else:\n" +
    "    print(json.dumps({'ok': True, 'provider': 'anysearch', 'query': args[1] if len(args) > 1 else '', 'results': [{'title': 'Exa API', 'url': 'https://exa.ai/docs'}]}, ensure_ascii=False))\n",
)

/** web 成功探针：无论哪条子命令都 ok:true（用于断言成功时**不**多跑第二条）。 */
const WEB_OK = "web_ok_probe"
const REC_OK = join(FIX, "web_ok.rec")
writePy(
  `${WEB_OK}.py`,
  "import sys, json\n" +
    `REC = ${JSON.stringify(REC_OK)}\n` +
    "args = sys.argv[1:]\n" +
    "open(REC, 'a').write(json.dumps(args, ensure_ascii=False) + '\\n')\n" +
    "print(json.dumps({'ok': True, 'provider': args[0] if args else 'search', 'query': args[1] if len(args) > 1 else ''}, ensure_ascii=False))\n",
)

/** web 双失败探针：search → config_error/main_search；anysearch-search → ok:false(upstream_error 503)。 */
const WEB_BOTH_FAIL = "web_both_fail_probe"
const REC_BOTH = join(FIX, "web_both.rec")
writePy(
  `${WEB_BOTH_FAIL}.py`,
  "import sys, json\n" +
    `REC = ${JSON.stringify(REC_BOTH)}\n` +
    "args = sys.argv[1:]\n" +
    "open(REC, 'a').write(json.dumps(args, ensure_ascii=False) + '\\n')\n" +
    "sub = args[0] if args else ''\n" +
    "if sub == 'search':\n" +
    "    print(json.dumps({'ok': False, 'error_type': 'config_error', 'error': 'Missing capabilities: main_search'}, ensure_ascii=False))\n" +
    "else:\n" +
    "    print(json.dumps({'ok': False, 'error_type': 'upstream_error', 'error': 'anysearch upstream 503 service unavailable'}, ensure_ascii=False))\n",
)

/**
 * 真实 CLI 行为探针：config_error 时 CLI **非零退出**（cli.py `_exit_code`: config_error→EXIT_CONFIG_ERROR=3），
 * 但仍印合法 JSON ok:false。工具必须据 JSON（而非 exit code）判成敗并触发回落。
 */
const WEB_NONZERO = "web_nonzero_probe"
const REC_NONZERO = join(FIX, "web_nonzero.rec")
writePy(
  `${WEB_NONZERO}.py`,
  "import sys, json\n" +
    `REC = ${JSON.stringify(REC_NONZERO)}\n` +
    "args = sys.argv[1:]\n" +
    "open(REC, 'a').write(json.dumps(args, ensure_ascii=False) + '\\n')\n" +
    "sub = args[0] if args else ''\n" +
    "if sub == 'search':\n" +
    "    print(json.dumps({'ok': False, 'error_type': 'config_error', 'error': 'Missing capabilities: main_search'}, ensure_ascii=False))\n" +
    "    sys.exit(3)\n" +
    "else:\n" +
    "    print(json.dumps({'ok': True, 'provider': 'anysearch', 'results': [{'title': 'Exa', 'url': 'https://exa.ai/'}]}, ensure_ascii=False))\n",
)

/** 读 rec（每行一个 JSON 数组＝一次调用的 argv）；不存在＝空。 */
function readRec(path: string): string[][] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[])
}

/** 每个场景开始前清空 rec，确保断言的是本次调用。 */
function resetRec(path: string): void {
  rmSync(path, { force: true })
}

afterAll(() => {
  rmSync(FIX, { recursive: true, force: true })
  rmSync(ENV_HOME, { recursive: true, force: true })
})

const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" }

function out<T = Record<string, unknown>>(res: { output: string }): T {
  return JSON.parse(res.output) as T
}

/** 以 fixture 模块执行工具（PYTHONPATH=FIX 让 `-m <module>` 解析到 fixture）。 */
function runWithFixture(
  fixtureModule: string,
  args: Record<string, unknown>,
  extra: { timeoutMs?: number; envSource?: NodeJS.ProcessEnv } = {},
) {
  return runSmartSearchTool(args, {
    cliModule: fixtureModule,
    pythonPath: FIX,
    ...extra,
  })
}

describe("smart_search：intent → 子命令映射", () => {
  test("page → fetch <url>", () => {
    expect(resolveSubcommand("page", { url: "https://example.com" })).toEqual(["fetch", "https://example.com"])
  })
  test("docs 无 library_id → context7-library <query>", () => {
    expect(resolveSubcommand("docs", { query: "react hooks" })).toEqual(["context7-library", "react hooks"])
  })
  test("docs 有 library_id → context7-docs <library_id> <query>", () => {
    expect(resolveSubcommand("docs", { query: "hooks", library_id: "/reactjs/react.dev" })).toEqual([
      "context7-docs",
      "/reactjs/react.dev",
      "hooks",
    ])
  })
  test("web → search <query>", () => {
    expect(resolveSubcommand("web", { query: "exa api" })).toEqual(["search", "exa api"])
  })

  test("真实 argv 到达子进程（page，含 --format json）", async () => {
    const res = await runWithFixture(ARGV_ECHO, { intent: "page", url: "https://example.com" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; result: string[] }>(res)
    expect(o.ok).toBe(true)
    expect(o.result).toEqual(["fetch", "https://example.com", "--format", "json"])
  })

  test("真实 argv 到达子进程（docs 带 library_id）", async () => {
    const res = await runWithFixture(
      ARGV_ECHO,
      { intent: "docs", query: "hooks", library_id: "/reactjs/react.dev" },
      { envSource: BASE_ENV },
    )
    const o = out<{ ok: boolean; result: string[] }>(res)
    expect(o.result).toEqual(["context7-docs", "/reactjs/react.dev", "hooks", "--format", "json"])
  })
})

describe("smart_search：逾时推导", () => {
  test("page=60s / docs=60s / web=120s", () => {
    expect(resolveTimeoutMs("page")).toBe(SMART_SEARCH_TIMEOUT_PAGE_MS)
    expect(resolveTimeoutMs("docs")).toBe(SMART_SEARCH_TIMEOUT_DOCS_MS)
    expect(resolveTimeoutMs("web")).toBe(SMART_SEARCH_TIMEOUT_WEB_MS)
    expect(SMART_SEARCH_TIMEOUT_PAGE_MS).toBe(60_000)
    expect(SMART_SEARCH_TIMEOUT_WEB_MS).toBe(120_000)
  })

  test("慢子进程被 SIGKILL → upstream_timeout，消息含 intent 与已等时长", async () => {
    const res = await runWithFixture(SLOW, { intent: "page", url: "https://example.com" }, { timeoutMs: 400, envSource: BASE_ENV })
    const o = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    expect(o.ok).toBe(false)
    expect(o.error.code).toBe("upstream_timeout")
    expect(o.error.hint).toContain("page")
    expect(o.error.hint).toContain("已等待")
  })
})

describe("smart_search：spawn 注入防护", () => {
  test("query 含 `; rm -rf <哨兵>` 被视为单一 argv，哨兵目录仍在", async () => {
    mkdirSync(SENTINEL, { recursive: true })
    const malicious = `x; rm -rf ${SENTINEL}`
    const res = await runWithFixture(ARGV_ECHO, { intent: "web", query: malicious }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; result: string[] }>(res)
    // 完整恶意串作为**单一** argv 元素到达（未被 shell 拆开）。
    expect(o.result).toEqual(["search", malicious, "--format", "json"])
    // 哨兵目录未被删除（未发生 shell 执行）。
    expect(existsSync(SENTINEL)).toBe(true)
  })
})

describe("smart_search：子进程 env 白名单", () => {
  test("EXA_API_KEY 透传、SECRET_TOKEN 不传、HOME/PYTHONPATH 已设", async () => {
    const res = await runWithFixture(ENV_PROBE, { intent: "page", url: "https://example.com" }, {
      envSource: { ...BASE_ENV, EXA_API_KEY: "fake-exa", SECRET_TOKEN: "must-not-leak" },
    })
    const o = out<{ ok: boolean; result: { has_exa: boolean; has_secret: boolean; home: string; pythonpath: string } }>(res)
    expect(o.result.has_exa).toBe(true)
    expect(o.result.has_secret).toBe(false)
    expect(o.result.home).toContain("smart-search-")
    expect(o.result.pythonpath).toBe(FIX)
  })
})

describe("smart_search：输出解析", () => {
  test("合法 JSON 原样透传", async () => {
    const res = await runWithFixture(VALID, { intent: "page", url: "https://example.com" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; result: { ok: boolean; provider: string; content: string } }>(res)
    expect(o.ok).toBe(true)
    expect(o.result.ok).toBe(true)
    expect(o.result.provider).toBe("jina")
    expect(o.result.content).toContain("Example Domain")
  })

  test("非 JSON → bad_output", async () => {
    const res = await runWithFixture(NOT_JSON, { intent: "page", url: "https://example.com" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    expect(o.ok).toBe(false)
    expect(o.error.code).toBe("bad_output")
  })

  test("非零退出 → upstream_exit，带 stderr 摘录", async () => {
    const res = await runWithFixture(NONZERO, { intent: "page", url: "https://example.com" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    expect(o.ok).toBe(false)
    expect(o.error.code).toBe("upstream_exit")
    expect(o.error.hint).toContain("boom stderr detail")
  })

  test("web 缺 main-search 凭证 → fail(config_error) 且 hint 可操作", async () => {
    const res = await runWithFixture(MISSING, { intent: "web", query: "exa api" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; error: { code: string; hint: string }; upstream: { ok: boolean } }>(res)
    expect(o.ok).toBe(false)
    expect(o.error.code).toBe("config_error")
    expect(o.upstream.ok).toBe(false)
    // 可操作 hint：明说要改用 search_web（或 search_aggregate / provider 子命令）。
    expect(o.error.hint).toContain("main_search")
    expect(o.error.hint).toContain("search_web")
    expect(o.error.hint).toContain("search_aggregate")
  })
})

describe("smart_search：参数校验", () => {
  test("非法 intent → invalid_args", async () => {
    const res = await runSmartSearchTool({ intent: "bogus" }, { envSource: BASE_ENV, cliModule: ARGV_ECHO, pythonPath: FIX })
    const o = out<{ ok: boolean; error: { code: string } }>(res)
    expect(o.ok).toBe(false)
    expect(o.error.code).toBe("invalid_args")
  })
  test("page 缺 url → invalid_args", async () => {
    const res = await runSmartSearchTool({ intent: "page" }, { envSource: BASE_ENV, cliModule: ARGV_ECHO, pythonPath: FIX })
    const o = out<{ ok: boolean; error: { code: string } }>(res)
    expect(o.error.code).toBe("invalid_args")
  })
  test("docs 缺 query → invalid_args", async () => {
    const res = await runSmartSearchTool({ intent: "docs" }, { envSource: BASE_ENV, cliModule: ARGV_ECHO, pythonPath: FIX })
    const o = out<{ ok: boolean; error: { code: string } }>(res)
    expect(o.error.code).toBe("invalid_args")
  })
  test("registry id = 档名 smart_search", () => {
    expect([...SMART_SEARCH_HARNESS_TOOL_IDS]).toEqual(["smart_search"])
  })
})

describe("smart_search：web intent 免 Key 回落（search → anysearch-search）", () => {
  test("真实 CLI 非零退出(exit 3)但 stdout 合法 JSON ok:false(config_error) → 仍触发回落", async () => {
    resetRec(REC_NONZERO)
    const res = await runWithFixture(WEB_NONZERO, { intent: "web", query: "exa api" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; served_by: string; result: { provider: string } }>(res)
    const rec = readRec(REC_NONZERO)
    expect(rec.length).toBe(2)
    expect(rec[0][0]).toBe("search")
    expect(rec[1][0]).toBe("anysearch-search")
    expect(o.ok).toBe(true)
    expect(o.served_by).toBe("smartsearch:anysearch-search")
    expect(o.result.provider).toBe("anysearch")
  })

  test("search 回 ok:false(config_error/main_search) → 确实改跑 anysearch-search，served_by 标回落通路", async () => {
    resetRec(REC_FALLBACK)
    const res = await runWithFixture(WEB_FALLBACK, { intent: "web", query: "exa api" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; served_by: string; result: { provider: string; results: Array<{ url: string }> } }>(res)
    // 真行为证据：fixture 回显的被调用子命令序列。
    const rec = readRec(REC_FALLBACK)
    expect(rec.length).toBe(2)
    expect(rec[0][0]).toBe("search")
    expect(rec[1][0]).toBe("anysearch-search")
    expect(rec[1]).toContain("exa api")
    expect(rec[1]).toContain("--format")
    // 外层回报标明实际通路 + 真结果。
    expect(o.ok).toBe(true)
    expect(o.served_by).toBe("smartsearch:anysearch-search")
    expect(o.result.provider).toBe("anysearch")
    expect(o.result.results[0].url).toContain("https://")
  })

  test("search 回 ok:true → 不得多跑第二条（fixture 只被调用一次），served_by 标 search", async () => {
    resetRec(REC_OK)
    const res = await runWithFixture(WEB_OK, { intent: "web", query: "exa api" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; served_by: string }>(res)
    const rec = readRec(REC_OK)
    expect(rec.length).toBe(1)
    expect(rec[0][0]).toBe("search")
    expect(o.ok).toBe(true)
    expect(o.served_by).toBe("smartsearch:search")
  })

  test("两條都失败 → fail 且 hint 同时含两條错误与可操作建议", async () => {
    resetRec(REC_BOTH)
    const res = await runWithFixture(WEB_BOTH_FAIL, { intent: "web", query: "exa api" }, { envSource: BASE_ENV })
    const o = out<{ ok: boolean; error: { code: string; hint: string }; attempts: Array<{ served_by: string }> }>(res)
    const rec = readRec(REC_BOTH)
    expect(rec.length).toBe(2)
    expect(rec[1][0]).toBe("anysearch-search")
    expect(o.ok).toBe(false)
    // ① 两條通路各自的 error_type／訊息。
    expect(o.error.hint).toContain("config_error")
    expect(o.error.hint).toContain("main_search")
    expect(o.error.hint).toContain("upstream_error")
    expect(o.error.hint).toContain("anysearch upstream 503")
    // ② 可操作建议。
    expect(o.error.hint).toContain("search_web")
    expect(o.error.hint).toContain("search_aggregate")
    expect(o.attempts.map((a) => a.served_by)).toEqual(["smartsearch:search", "smartsearch:anysearch-search"])
  })

  test("主通路失败后剩余预算不足 → 如实回报（不静默截断，不发起第二条）", async () => {
    resetRec(REC_FALLBACK)
    const res = await runWithFixture(WEB_FALLBACK, { intent: "web", query: "exa api" }, { timeoutMs: 5_000, envSource: BASE_ENV })
    const o = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    const rec = readRec(REC_FALLBACK)
    // 真行为证据：只跑过主通路，未发起回落。
    expect(rec.length).toBe(1)
    expect(rec[0][0]).toBe("search")
    expect(o.ok).toBe(false)
    expect(o.error.code).toBe("upstream_timeout")
    expect(o.error.hint).toContain("仅剩")
    expect(o.error.hint).toContain("anysearch-search")
  })
})
