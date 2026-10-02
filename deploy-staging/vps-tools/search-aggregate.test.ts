// search_aggregate 工具真值测试（跨平台聚合检索的工具化）。
//
// 全部为**真行为断言**（不是源码字符串扫描）：
//   1. 注入防护：造 fixture python 脚本回显 sys.argv，传含 `; rm -rf <哨兵>` 的 query，
//      断言 fixture 收到的是**一个完整 argv 元素**、哨兵目录仍在（未被 shell 解析执行）。
//   2. 平台集 → 逾时推导（含 reddit=240s / 不含=45s）。
//   3. 解析路径：合法 JSON 原样透传 / 非 JSON=bad_output / 非零退出=upstream_exit / 逾时=upstream_timeout。
//   4. 单平台 ok:false（reddit 中文被挡）不得让整体判失败。
//   5. 子进程 env 白名单：不传 TAVILY/EXA，HOME 指向可写 tmp。
//
// 跑法：bun test deploy-staging/vps-tools/search-aggregate.test.ts
//   或：bash deploy-staging/vps-tools/run-tests.sh ../vps-tools/search-aggregate.test.ts
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, test } from "bun:test"

import {
  AGGREGATE_DEFAULT_PLATFORMS,
  AGGREGATE_SEARCH_SCRIPT,
  AGGREGATE_TIMEOUT_MS,
  AGGREGATE_TIMEOUT_REDDIT_MS,
  buildChildEnv,
  platformsIncludeReddit,
  resolveTimeoutMs,
  runAggregateTool,
} from "../opencode-runtime/lib/search_aggregate_impl"

const FIX = mkdtempSync(join(tmpdir(), "search-aggregate-fixture-"))
const HOME = mkdtempSync(join(tmpdir(), "search-aggregate-home-"))
const SENTINEL = join(FIX, "injection-sentinel")

function writePy(name: string, body: string): string {
  const p = join(FIX, name)
  writeFileSync(p, body, "utf8")
  return p
}

// 回显收到的 argv（数组），供注入防护断言。
const argvEcho = writePy(
  "argv_echo.py",
  "import sys, json\nprint(json.dumps(sys.argv[1:], ensure_ascii=False))\n",
)
// 合法 JSON（含 github 单平台结果）。
const validPy = writePy(
  "valid.py",
  "import sys, json\n" +
    "print(json.dumps({'query': sys.argv[1], 'platforms': [{'platform': 'github', 'ok': True, " +
    "'results': [{'title': 't', 'url': 'u'}]}]}, ensure_ascii=False))\n",
)
// 非 JSON 输出。
const notJsonPy = writePy("notjson.py", "print('this is not json')\n")
// 非零退出 + stderr。
const nonzeroPy = writePy(
  "nonzero.py",
  "import sys\nsys.stderr.write('boom stderr detail')\nsys.exit(3)\n",
)
// 睡到被 SIGKILL。
const slowPy = writePy("slow.py", "import time\ntime.sleep(30)\n")
// 单平台 ok:false（模拟 reddit 对中文关键词硬挡），另一平台 ok:true。
const oneFailPy = writePy(
  "onefail.py",
  "import json\n" +
    "print(json.dumps({'query': 'q', 'platforms': [" +
    "{'platform': 'bilibili', 'ok': True, 'results': [{'title': 't', 'url': 'u'}]}, " +
    "{'platform': 'reddit', 'ok': False, 'results': [], 'error': 'reddit 是英文平台，中文关键词搜不到内容'}" +
    "]}, ensure_ascii=False))\n",
)
// 全部平台 ok:false（模拟查询语种/平台全不匹配，脚本逐平台失败）。
const allFailPy = writePy(
  "allfail.py",
  "import json\n" +
    "print(json.dumps({'query': 'q', 'platforms': [" +
    "{'platform': 'bilibili', 'ok': False, 'results': [], 'error': 'x'}, " +
    "{'platform': 'github', 'ok': False, 'results': [], 'error': 'y'}" +
    "]}, ensure_ascii=False))\n",
)

afterAll(() => {
  rmSync(FIX, { recursive: true, force: true })
  rmSync(HOME, { recursive: true, force: true })
})

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" }

function out<T = Record<string, unknown>>(res: { output: string }): T {
  return JSON.parse(res.output) as T
}

// ── 1. 注入防护（真行为）─────────────────────────────────────────────────────
describe("注入防护", () => {
  test("query 作为单一 argv 元素传入，不经 shell 解析", async () => {
    mkdirSync(SENTINEL, { recursive: true })
    writeFileSync(join(SENTINEL, "keep.txt"), "keep", "utf8")
    const evil = `a; rm -rf ${SENTINEL}`

    const res = await runAggregateTool(
      { query: evil, platforms: "github" },
      { scriptPath: argvEcho, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; raw: string[] }>(res)
    expect(parsed.ok).toBe(true)
    // fixture 收到 6 个 argv 元素，第 0 个就是完整 query（分号/空格未被 shell 拆解）
    expect(parsed.raw).toEqual([evil, "--platform", "github", "--max", "8", "--json"])
    expect(parsed.raw[0]).toBe(evil)
    expect(parsed.raw.length).toBe(6)
    // 若走 shell，哨兵目录会被 rm 掉；它仍在 = 证明未被 shell 解析执行
    expect(existsSync(join(SENTINEL, "keep.txt"))).toBe(true)
  })
})

// ── 2. 平台集 → 逾时推导 ─────────────────────────────────────────────────────
describe("逾时推导", () => {
  test("含 reddit 得 240s、不含得 45s", () => {
    expect(resolveTimeoutMs("bilibili,github")).toBe(AGGREGATE_TIMEOUT_MS)
    expect(resolveTimeoutMs("bilibili,github")).toBe(45_000)
    expect(resolveTimeoutMs("reddit")).toBe(AGGREGATE_TIMEOUT_REDDIT_MS)
    expect(resolveTimeoutMs("reddit")).toBe(240_000)
    expect(resolveTimeoutMs("all")).toBe(240_000)
    expect(resolveTimeoutMs("all,-xhs")).toBe(240_000)
    // 显式排除 reddit 语义解析
    expect(resolveTimeoutMs("all,-reddit")).toBe(45_000)
  })

  test("platformsIncludeReddit 语义解析", () => {
    expect(platformsIncludeReddit("bilibili,github")).toBe(false)
    expect(platformsIncludeReddit("reddit")).toBe(true)
    expect(platformsIncludeReddit("all")).toBe(true)
    expect(platformsIncludeReddit("all,-reddit")).toBe(false)
  })

  test("默认平台集为 bilibili,github（不含 reddit / tavily）", () => {
    expect(AGGREGATE_DEFAULT_PLATFORMS).toBe("bilibili,github")
  })

  test("省略 platforms 时透传默认集到子进程", async () => {
    const res = await runAggregateTool({ query: "test" }, { scriptPath: argvEcho, timeoutMs: 10_000, envSource: ENV })
    const parsed = out<{ ok: boolean; raw: string[] }>(res)
    expect(parsed.raw).toEqual(["test", "--platform", "bilibili,github", "--max", "8", "--json"])
  })
})

// ── 3. 解析路径 ──────────────────────────────────────────────────────────────
describe("解析路径", () => {
  test("合法 JSON 原样透传（不重组字段）", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "github" },
      { scriptPath: validPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; raw: unknown; platforms_requested: string }>(res)
    expect(parsed.ok).toBe(true)
    expect(parsed.platforms_requested).toBe("github")
    expect(parsed.raw).toEqual({
      query: "q",
      platforms: [{ platform: "github", ok: true, results: [{ title: "t", url: "u" }] }],
    })
  })

  test("非 JSON 输出 → bad_output 并附前文", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "github" },
      { scriptPath: notJsonPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("bad_output")
    expect(parsed.error.hint).toContain("this is not json")
  })

  test("非零退出 → upstream_exit 并附 stderr", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "github" },
      { scriptPath: nonzeroPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("upstream_exit")
    expect(parsed.error.hint).toContain("boom stderr detail")
  })

  test("逾时 → upstream_timeout（SIGKILL），讯息含平台集与已等多久", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "reddit" },
      { scriptPath: slowPy, timeoutMs: 1_200, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; error: { code: string; hint: string } }>(res)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("upstream_timeout")
    expect(parsed.error.hint).toContain("reddit")
    expect(parsed.error.hint).toContain("1200")
  })
})

// ── 4. 单平台失败不拖垮整体 ─────────────────────────────────────────────────
describe("单平台 ok:false 不判整体失败", () => {
  test("reddit 中文被挡（ok:false）时整体仍 ok:true", async () => {
    const res = await runAggregateTool(
      { query: "猫粮", platforms: "bilibili,reddit" },
      { scriptPath: oneFailPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; raw: { platforms: Array<{ platform: string; ok: boolean }> } }>(res)
    expect(parsed.ok).toBe(true)
    const plats = parsed.raw.platforms
    expect(plats.find((p) => p.platform === "bilibili")?.ok).toBe(true)
    expect(plats.find((p) => p.platform === "reddit")?.ok).toBe(false)
  })
})

// ── 5. 子进程 env 白名单 ─────────────────────────────────────────────────────
describe("子进程 env 白名单", () => {
  test("不传 TAVILY/EXA 与其他密钥，HOME 指向给定可写目录", () => {
    const env = buildChildEnv(
      {
        PATH: "/usr/bin:/bin",
        TAVILY_API_KEY: "secret-tavily",
        EXA_API_KEY: "secret-exa",
        OPENAI_API_KEY: "secret-openai",
      } as NodeJS.ProcessEnv,
      HOME,
    )
    expect(env.TAVILY_API_KEY).toBeUndefined()
    expect(env.EXA_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.HOME).toBe(HOME)
    expect(env.AGGREGATE_SEARCH_STATE_DIR).toBe(join(HOME, "state"))
    expect(env.PATH).toBe("/usr/bin:/bin")
    expect(env.LC_ALL).toBe("C.UTF-8")
  })
})

// ── 6. 参数校验 ──────────────────────────────────────────────────────────────
describe("参数校验", () => {
  test("缺 query → invalid_args", async () => {
    const parsed = out<{ ok: boolean; error: { code: string } }>(await runAggregateTool({}, {}))
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("invalid_args")
  })

  test("max 超上限静默收敛到 20", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "github", max: 999 },
      { scriptPath: argvEcho, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ raw: string[] }>(res)
    expect(parsed.raw[4]).toBe("20")
  })

  test("max 非法 → invalid_args", async () => {
    const parsed = out<{ ok: boolean; error: { code: string } }>(
      await runAggregateTool({ query: "q", max: 0 }, {}),
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe("invalid_args")
  })
})

// ── 7. 模块相对路径真的可执行（真跑脚）──────────────────────────────────────
describe("脚本路径由模块自身位置推导且真的可跑", () => {
  test("python3 <模块推导的绝对路径> --list 退出 0 并列出 bilibili", () => {
    const r = spawnSync("python3", [AGGREGATE_SEARCH_SCRIPT, "--list"], {
      env: { PATH: ENV.PATH },
      encoding: "utf8",
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("bilibili")
  })
})

// ── 8. coverage_notice（输出内在场提示，本輪分流培訓的验收点）────────────────
describe("coverage_notice 使用当下纠错提示", () => {
  test("成功路径恒带 coverage_notice，含实际 platforms 与 search_web", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "github" },
      { scriptPath: validPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; coverage_notice: string }>(res)
    expect(parsed.ok).toBe(true)
    expect(typeof parsed.coverage_notice).toBe("string")
    expect(parsed.coverage_notice).toContain("github")
    expect(parsed.coverage_notice).toContain("search_web")
    // 单平台情境：notice 不得提到未查询的平台（必须反映实际 platforms，不是固定文案）
    expect(parsed.coverage_notice).not.toContain("bilibili")
  })

  test("省略 platforms 时 notice 反映实际的默认平台集", async () => {
    const res = await runAggregateTool({ query: "q" }, { scriptPath: validPy, timeoutMs: 10_000, envSource: ENV })
    const parsed = out<{ coverage_notice: string }>(res)
    expect(parsed.coverage_notice).toContain("bilibili,github")
    expect(parsed.coverage_notice).toContain("search_web")
  })

  test("全部平台 ok:false 时仍带 coverage_notice，hint 也含 search_web", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "bilibili,github" },
      { scriptPath: allFailPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ ok: boolean; coverage_notice: string; hint: string }>(res)
    expect(parsed.ok).toBe(true)
    expect(parsed.coverage_notice).toContain("bilibili,github")
    expect(parsed.coverage_notice).toContain("search_web")
    expect(parsed.hint).toContain("search_web")
  })

  test("既有字段名称与语义不变（platforms_requested/raw 原样）", async () => {
    const res = await runAggregateTool(
      { query: "q", platforms: "github" },
      { scriptPath: validPy, timeoutMs: 10_000, envSource: ENV },
    )
    const parsed = out<{ platforms_requested: string; raw: unknown }>(res)
    expect(parsed.platforms_requested).toBe("github")
    expect(parsed.raw).toEqual({
      query: "q",
      platforms: [{ platform: "github", ok: true, results: [{ title: "t", url: "u" }] }],
    })
  })
})
