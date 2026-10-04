// eimu-shell 真值测试（方案 B：spawn 当下注入沙箱）。全部用**真跑子程序**验证，不是字串断言。
//
// 验收三态：
//   (a) EIMU_LAUNCHER 未设 → 逐字等同 /bin/bash（透明）。
//   (b) EIMU_LAUNCHER 指向假 launcher（记录自己收到的 argv）→ 假 launcher 收到 ("$PWD", "<cmd>")。
//   (c) EIMU_LAUNCHER 指向不存在路径 → fail-closed（非零退出、绝不回退成无沙箱执行）。
// 另加 (d) launcher 已设但非 `-c` 形态 → 仍透明（保护 opencode 内部把 shell 当工具用的呼叫）。
//
// 跑法：bun test deploy-staging/vps-tools/eimu-shell.test.ts
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { afterAll, describe, expect, test } from "bun:test"

const SHELL = resolve(import.meta.dir, "../opencode-runtime/lib/eimu-shell")

type RunOpts = { env?: Record<string, string>; cwd?: string }
function run(args: string[], opts: RunOpts = {}) {
  return spawnSync(SHELL, args, {
    cwd: opts.cwd ?? tmpdir(),
    // 全新 env（不继承外层，确保 (a) 的 EIMU_LAUNCHER 真的未设）；只留 PATH。
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(opts.env ?? {}) },
    encoding: "utf8",
  })
}

/** 建一个假 launcher：把自己收到的每个 argv 逐行写进 $EIMU_TEST_REC，然后退出 0（不执行命令）。 */
function makeFakeLauncher(): { launcher: string; recFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "eimu-shell-fake-"))
  const launcher = join(dir, "fake-launcher.sh")
  const recFile = join(dir, "argv.txt")
  writeFileSync(
    launcher,
    "#!/bin/bash\n" + 'printf \'%s\\n\' "$@" > "$EIMU_TEST_REC"\n' + "exit 0\n",
  )
  chmodSync(launcher, 0o755)
  return { launcher, recFile }
}

describe("eimu-shell 三态真值", () => {
  test("(a) EIMU_LAUNCHER 未设 → <shell> -c 'echo hi' 逐字等同 /bin/bash -c 'echo hi'", () => {
    expect(existsSync(SHELL)).toBe(true)
    const got = run(["-c", "echo hi"])
    const ref = spawnSync("/bin/bash", ["-c", "echo hi"], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      encoding: "utf8",
    })
    expect(got.status).toBe(0)
    expect(got.stdout).toBe(ref.stdout)
    expect(got.stdout).toBe("hi\n")
    expect(got.stderr).toBe(ref.stderr)
  })

  test("(b) EIMU_LAUNCHER 指向假 launcher → 假 launcher 收到 ($PWD, 'echo hi')", () => {
    const { launcher, recFile } = makeFakeLauncher()
    const cwd = mkdtempSync(join(tmpdir(), "eimu-shell-cwd-"))
    const got = run(["-c", "echo hi"], {
      cwd,
      env: { EIMU_LAUNCHER: launcher, EIMU_TEST_REC: recFile },
    })
    expect(got.status).toBe(0)
    expect(got.stdout).toBe("") // 假 launcher 不执行命令
    expect(existsSync(recFile)).toBe(true)
    const argv = readFileSync(recFile, "utf8").split("\n").filter((l) => l.length > 0)
    expect(argv.length).toBe(2)
    expect(argv[0]).toBe(resolve(cwd)) // $PWD（真跑子程序时 bash 以 getcwd 修正）
    expect(argv[1]).toBe("echo hi") // 命令本体：模型上下文那一份就是它
  })

  test("(c) EIMU_LAUNCHER 指向不存在路径 → fail-closed（不回退无沙箱执行）", () => {
    const missing = join(tmpdir(), `eimu-no-such-launcher-${process.pid}`)
    expect(existsSync(missing)).toBe(false)
    const got = run(["-c", "echo hi"], { env: { EIMU_LAUNCHER: missing } })
    expect(got.status).not.toBe(0)
    expect(got.status).toBe(127)
    expect(got.stdout).not.toContain("hi") // 关键：命令没有被执行
    expect(got.stderr).toContain("EIMU_LAUNCHER")
    expect(got.stderr).toContain("拒绝")
  })

  test("(d) launcher 已设但非 `-c` 形态 → 仍透明（内部呼叫不受影响）", () => {
    const { launcher, recFile } = makeFakeLauncher()
    const got = run(["--version"], { env: { EIMU_LAUNCHER: launcher, EIMU_TEST_REC: recFile } })
    expect(got.status).toBe(0)
    expect(got.stdout).toContain("GNU bash") // 真的交给 /bin/bash --version
    expect(existsSync(recFile)).toBe(false) // 假 launcher 没被叫
  })

  test("(e) EIMU_LAUNCHER 设为空字串 → 视同未设（透明）", () => {
    const got = run(["-c", "echo hi"], { env: { EIMU_LAUNCHER: "" } })
    expect(got.status).toBe(0)
    expect(got.stdout).toBe("hi\n")
  })
})

// ── 回归（2026-10-02 生产缺口）：ensureSessionLauncher 必须先建好 bwrap --bind 的宿主来源目录 ──
// 缺口：裸 POST /session/{id}/shell 不经 plugin tool.execute.before，而目录建立旧版只长在
// wrapShellCommand／ensureDirs 里 → bwrap: Can't find source path .../.run/<slug>/tmp。
// 隔离：sandbox.ts 的 WORKSPACE 支援 EIMU_WORKSPACE 覆写（未设＝生产路径逐字不变），
// 故可在干净临时根**真跑** launcher→bwrap，直接证明 source path 存在。
// 临时根刻意放 /var/tmp：/tmp 会被沙箱自身 `--bind tmp /tmp` 覆盖，/home、/root、/opt 被 tmpfs 遮罩。
const LAUNCH_ROOT = mkdtempSync(join("/var/tmp", "eimu-sandbox-"))
process.env.EIMU_WORKSPACE = LAUNCH_ROOT
const sandbox = await import("../opencode-runtime/lib/sandbox")
const SID = "sess-launcher-dirs-regression"

afterAll(() => {
  rmSync(LAUNCH_ROOT, { recursive: true, force: true })
})

describe("ensureSessionLauncher 建立 bwrap --bind 宿主目录（裸 shell 端点回归）", () => {
  test("(a) launcher 存在且可执行；tmp/run/WORKSPACE/RUN_ROOT 等宿主来源都在", () => {
    const file = sandbox.ensureSessionLauncher(SID)
    expect(file).toBe(sandbox.sessionLauncherPath(SID))
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o755)
    // sandboxArgv 会 bind 的宿主来源（source 不存在即 bwrap fail-closed）
    expect(existsSync(sandbox.sessionTmpDir(SID))).toBe(true)
    expect(existsSync(sandbox.sessionRunDir(SID))).toBe(true)
    expect(existsSync(sandbox.WORKSPACE)).toBe(true) // --bind WORKSPACE WORKSPACE
    expect(existsSync(sandbox.RUN_ROOT)).toBe(true) // maskArgs: --tmpfs RUN_ROOT
  })

  test("(b) 幂等：连续两次呼叫不报错、回传同一路径", () => {
    const a = sandbox.ensureSessionLauncher(SID)
    const b = sandbox.ensureSessionLauncher(SID)
    expect(a).toBe(b)
    expect(existsSync(a)).toBe(true)
  })

  test("(c) 每会话目录权限 0o700（tmp / run / launcher 目录）", () => {
    sandbox.ensureSessionLauncher(SID)
    for (const d of [sandbox.sessionTmpDir(SID), sandbox.sessionRunDir(SID), dirname(sandbox.sessionLauncherPath(SID))]) {
      expect(statSync(d).mode & 0o777).toBe(0o700)
    }
  })

  test("(d) 真跑子程序：生成的 launcher 在 bwrap 内执行命令并回传输出（原缺口＝source path 不存在）", () => {
    const launcher = sandbox.ensureSessionLauncher(SID)
    const runDir = sandbox.sessionRunDir(SID)
    const got = spawnSync(launcher, [runDir, "echo SANDBOX_OK"], { encoding: "utf8" })
    expect(got.stderr ?? "").not.toContain("Can't find source path")
    expect(got.status).toBe(0)
    expect(got.stdout.trim()).toBe("SANDBOX_OK")
  })
})
