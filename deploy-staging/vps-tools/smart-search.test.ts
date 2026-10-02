// smart_search 工具真值测试（smartsearch 免 Key 通路工具化）。
//
// 全部为**真行为断言**（不是源码字符串扫描）：
//   1. intent → 子命令映射：fixture 回显 sys.argv，断言 page/docs(带/不带 library_id)/web 的 argv 正确。
//   2. 逾时推导：page=60s / docs=60s / web=120s；慢 fixture → upstream_timeout（SIGKILL）。
//   3. 注入防护：query 含 `; rm -rf <哨兵>`，断言 fixture 收到**一个完整 argv 元素**、哨兵目录仍在
//      （未被 shell 解析执行）。
//   4. 子进程 env 白名单：EXA_API_KEY 透传、SECRET_TOKEN 不传、HOME/PYTHONPATH 已设。
//   5. 解析路径：合法 JSON 透传 / 非 JSON=bad_output / 非零退出=upstream_exit。
//   6. web intent 因缺 main-search 凭证回 ok:false 时 → 工具 fail(config_error) 且 hint 可操作
//      （含 search_web 替代指引）。
//
// 跑法：bun test deploy-staging/vps-tools/smart-search.test.ts
//   或：bash deploy-staging/vps-tools/run-tests.sh ../vps-tools/smart-search.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
