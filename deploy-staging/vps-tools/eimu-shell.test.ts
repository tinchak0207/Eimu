// eimu-shell 真值測試（方案 B：spawn 當下注入沙箱）。全部用**真跑子程序**驗證，不是字串斷言。
//
// 驗收三態：
//   (a) EIMU_LAUNCHER 未設 → 逐字等同 /bin/bash（透明）。
//   (b) EIMU_LAUNCHER 指向假 launcher（記錄自己收到的 argv）→ 假 launcher 收到 ("$PWD", "<cmd>")。
//   (c) EIMU_LAUNCHER 指向不存在路徑 → fail-closed（非零退出、絕不回退成無沙箱執行）。
// 另加 (d) launcher 已設但非 `-c` 形態 → 仍透明（保護 opencode 內部把 shell 當工具用的呼叫）。
//
// 跑法：bun test deploy-staging/vps-tools/eimu-shell.test.ts
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, test } from "bun:test"

const SHELL = resolve(import.meta.dir, "../opencode-runtime/lib/eimu-shell")

type RunOpts = { env?: Record<string, string>; cwd?: string }
function run(args: string[], opts: RunOpts = {}) {
  return spawnSync(SHELL, args, {
    cwd: opts.cwd ?? tmpdir(),
    // 全新 env（不繼承外層，確保 (a) 的 EIMU_LAUNCHER 真的未設）；只留 PATH。
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...(opts.env ?? {}) },
    encoding: "utf8",
  })
}

/** 建一個假 launcher：把自己收到的每個 argv 逐行寫進 $EIMU_TEST_REC，然後退出 0（不執行命令）。 */
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

describe("eimu-shell 三態真值", () => {
  test("(a) EIMU_LAUNCHER 未設 → <shell> -c 'echo hi' 逐字等同 /bin/bash -c 'echo hi'", () => {
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
    expect(got.stdout).toBe("") // 假 launcher 不執行命令
    expect(existsSync(recFile)).toBe(true)
    const argv = readFileSync(recFile, "utf8").split("\n").filter((l) => l.length > 0)
    expect(argv.length).toBe(2)
    expect(argv[0]).toBe(resolve(cwd)) // $PWD（真跑子程序時 bash 以 getcwd 修正）
    expect(argv[1]).toBe("echo hi") // 命令本體：模型上下文那一份就是它
  })

  test("(c) EIMU_LAUNCHER 指向不存在路徑 → fail-closed（不回退無沙箱執行）", () => {
    const missing = join(tmpdir(), `eimu-no-such-launcher-${process.pid}`)
    expect(existsSync(missing)).toBe(false)
    const got = run(["-c", "echo hi"], { env: { EIMU_LAUNCHER: missing } })
    expect(got.status).not.toBe(0)
    expect(got.status).toBe(127)
    expect(got.stdout).not.toContain("hi") // 關鍵：命令沒有被執行
    expect(got.stderr).toContain("EIMU_LAUNCHER")
    expect(got.stderr).toContain("拒绝")
  })

  test("(d) launcher 已設但非 `-c` 形態 → 仍透明（內部呼叫不受影響）", () => {
    const { launcher, recFile } = makeFakeLauncher()
    const got = run(["--version"], { env: { EIMU_LAUNCHER: launcher, EIMU_TEST_REC: recFile } })
    expect(got.status).toBe(0)
    expect(got.stdout).toContain("GNU bash") // 真的交給 /bin/bash --version
    expect(existsSync(recFile)).toBe(false) // 假 launcher 沒被叫
  })

  test("(e) EIMU_LAUNCHER 設為空字串 → 視同未設（透明）", () => {
    const got = run(["-c", "echo hi"], { env: { EIMU_LAUNCHER: "" } })
    expect(got.status).toBe(0)
    expect(got.stdout).toBe("hi\n")
  })
})
