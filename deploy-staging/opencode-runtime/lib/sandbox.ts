// Agent 代码/档案存取沙箱与闸（2026-09-29 审计＋红队二轮修复）。
//
// 威胁模型：agent 跑用户输入，能调 bash/run_py（进 bwrap）与原生 read/write/edit/grep/... 及
// 读图等带 URL 的工具（原生工具跑在受信 opencode 进程，有全档案系统＋全 env＋网路）。
// 进程 env 有上游密钥；workspace 多租户（各用户档案在 uploads/<gateway-sessionId>/）；
// gateway /internal/* 是 loopback 无鉴权。
//
// 红队二轮推翻了「只沙箱 bash」的思路——原生工具才是主攻面。本档提供：
//   1. checkAgentPath：**白名单**（realpath 解析后必须落在 workspace 子树＋本会话 uploads），
//      挡 C1（预设放行）、H3（symlink 逃逸）、L13（前缀比对）。
//   2. 上传归属：由 plugin 从 gateway 可信查得（setOwner），非「用户提到即授权」（挡 H5）。
//   3. assertSafeFetchUrl：挡私网/loopback/link-local/云 metadata（挡 C2 SSRF）。
//   4. bwrap 沙箱：清 env、断网、unshare pid/ipc/uts、根唯读、遮蔽内部/他租户、/tmp 与 .run 按会话隔离（挡 L12）。
//   5. redactSecrets / filterForeignUploads：工具输出进上下文前的兜底。

import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { lookup as dnsLookup } from "node:dns/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { Readable } from "node:stream"
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib"

// WORKSPACE 预设为生产落点；允许 EIMU_WORKSPACE 覆写**仅为测试隔离**（可用干净临时根真跑
// bwrap，见 vps-tools/eimu-shell.test.ts）。未设时与旧版逐字相同，不改变任何 argv／可见性语义。
export const WORKSPACE = process.env.EIMU_WORKSPACE || "/opt/agent-harness/workspace"
export const UPLOADS = path.join(WORKSPACE, "uploads")
export const RUN_ROOT = path.join(WORKSPACE, ".run")
const BWRAP = "/usr/bin/bwrap"

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// ── 会话 → 可信上传归属（由 plugin 从 gateway /internal/session-key 查得后 setOwner）──
type Registry = { owner: Map<string, Set<string>> }
const REG: Registry = ((globalThis as any).__eimuUploadRegistry2 ??= { owner: new Map<string, Set<string>>() })

/** 以 gateway 可信结果设定本会话（opencode sessionID）拥有的 upload uuid 集合。 */
export function setOwner(sessionID: string, ownerUuids: string[]): void {
  if (!sessionID) return
  const set = new Set<string>()
  for (const u of ownerUuids) {
    const id = String(u ?? "").toLowerCase()
    if (/^[0-9a-f-]{36}$/.test(id)) set.add(id)
  }
  REG.owner.set(sessionID, set)
}

export function hasOwner(sessionID: string): boolean {
  return REG.owner.has(sessionID)
}

/** 本会话可存取的 upload 目录集合（无记录＝空集，fail-closed）。 */
export function allowedUploads(sessionID: string): Set<string> {
  return REG.owner.get(sessionID) ?? new Set<string>()
}

// ── 路径安全解析：realpath 已存在的最长前缀，防 symlink 逃逸；不存在的尾段按字面接上 ──
function safeResolve(rawPath: string): string {
  const abs = path.resolve(WORKSPACE, rawPath && rawPath.trim() ? rawPath : ".")
  let existing = abs
  const tail: string[] = []
  while (existing !== "/" && !existsSync(existing)) {
    tail.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }
  let real: string
  try {
    real = realpathSync(existing)
  } catch {
    real = existing
  }
  return tail.length ? path.join(real, ...tail) : real
}

function withinWorkspace(real: string): boolean {
  return real === WORKSPACE || real.startsWith(WORKSPACE + "/")
}

// workspace 内对 agent 关闭的区域（内部状态/设定/DB/服务）。
const DENY_IN_WORKSPACE = [".local/share/opencode", ".opencode-state"]
const DENY_OPENCODE_FILE_RE = /^\.opencode\/(opencode\.json[^/]*|opencode\.db[^/]*|[^/]*\.bak[^/]*|[^/]*redteam[^/]*|services(\/|$))/

export type PathVerdict = { ok: true } | { ok: false; reason: string }

/**
 * 白名单路径闸：realpath 解析后必须落在 workspace 子树；uploads 只放行本会话拥有的目录；
 * 内部状态/设定目录一律拒。listing=true 时额外拒 uploads 根（防列出全租户目录）。
 */
export function checkAgentPath(rawPath: string | undefined, sessionID: string, opts: { listing?: boolean } = {}): PathVerdict {
  const real = safeResolve(rawPath ?? ".")
  if (!withinWorkspace(real)) return { ok: false, reason: "outside_workspace" }
  const rel = real === WORKSPACE ? "" : path.relative(WORKSPACE, real)
  for (const d of DENY_IN_WORKSPACE) {
    if (rel === d || rel.startsWith(d + "/")) {
      // 例外：opencode 截断输出落盘档，agent 需按确切路径回读（不可列目录）。
      // read 类（listing=false）一律放行；grep/glob/list（listing=true）只放行「指向单一既有档案」
      // （截断提示叫 agent「Use Grep to search the full content」，H10：此前 grep 被 listing 挡成 internal_state）。
      if (rel.startsWith(".local/share/opencode/tool-output/")) {
        if (!opts.listing) return { ok: true }
        try {
          if (statSync(real).isFile()) return { ok: true }
        } catch {
          /* 不存在/不可 stat → 按拒绝 */
        }
      }
      return { ok: false, reason: "internal_state" }
    }
  }
  if (DENY_OPENCODE_FILE_RE.test(rel)) return { ok: false, reason: "internal_config" }
  if (rel === "uploads") return opts.listing ? { ok: false, reason: "uploads_root" } : { ok: true }
  if (rel === "uploads" || rel.startsWith("uploads/")) {
    const id = rel.split("/")[1]?.toLowerCase() ?? ""
    if (!id) return opts.listing ? { ok: false, reason: "uploads_root" } : { ok: true }
    if (!allowedUploads(sessionID).has(id)) return { ok: false, reason: "foreign_upload" }
  }
  return { ok: true }
}

/**
 * 值是否「看似档案路径」——供同时可收 base64／URL／路径的参数（music_gen.source_audio，
 * 2026-10-04 本地参考音档接线）决定是否进 checkAgentPath。纯 base64 字母表的值（含 + / =）
 * 不算路径：避免对 MB 级 base64 逐段 realpath/existsSync 解析（性能）与无谓拒收；
 * data:/http(s) 前缀同样不是档案路径（各自走 base64／明确报错分支）。
 * 注意：本函数只做**分类**，不是路径安全闸——真正放行/拒绝一律仍由 checkAgentPath 决定。
 */
export function looksLikeAgentPath(v: string): boolean {
  const s = (v ?? "").trim()
  if (!s) return false
  if (/^data:/i.test(s) || /^https?:\/\//i.test(s)) return false
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~/") || s.startsWith("uploads/")) return true
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(s)) return false
  return true
}

// ── SSRF 闸（C2）：挡私网/loopback/link-local/云 metadata；只允许 http(s) 公网 ──
// 各云 metadata 主机名（Tencent/Ali/Azure 用主机名而非 169.254 字面量，字串黑名单必须显式列）。
const BLOCKED_HOST_RE =
  /^(localhost|.*\.local|.*\.internal|metadata(\.google)?\.internal|metadata\.tencentyun\.com|metadata\.aliyuncs\.com|metadata\.azure\.com)$/i
function ipIsBlocked(host: string): boolean {
  let h = host.replace(/^\[|\]$/g, "").toLowerCase()
  // IPv4-mapped IPv6（::ffff:127.0.0.1 或 ::ffff:7f00:1）→ 取出内嵌 IPv4 再判。
  const mapped = /^::ffff:(.+)$/i.exec(h)
  if (mapped) {
    const tail = mapped[1]
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) h = tail
    else {
      const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail)
      if (hx) {
        const hi = parseInt(hx[1], 16)
        const lo = parseInt(hx[2], 16)
        h = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
      }
    }
  }
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 169 && b === 254) return true // link-local + 云 metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

export class SsrfError extends Error {}

/**
 * URL 是否安全可 fetch。先字面量预检（含 IPv4-mapped IPv6、各云 metadata 主机名），
 * 再用 getaddrinfo 正规化解析：`127.1`／十进位／十六进位 IP 字面量与「主机名→私网」
 * （如 metadata.tencentyun.com）都在此落网——解析口径与工具实际 fetch 一致。
 * 注：解析在此、fetch 在工具内，rebind/redirect 逐跳复验属残留（见 MEDIUM-1，需 fetch 层钉 IP）。
 */
export async function assertSafeFetchUrl(raw: string): Promise<void> {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new SsrfError("URL 格式无效。")
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("只允许 http/https 链接。")
  const host = u.hostname.replace(/^\[|\]$/g, "")
  if (!host || BLOCKED_HOST_RE.test(host) || ipIsBlocked(host)) throw new SsrfError("该链接指向内网/本机/元数据地址，已拒绝。")
  let addrs: { address: string }[]
  try {
    addrs = await dnsLookup(host, { all: true })
  } catch {
    return // 解析不了＝当下打不到，交由工具自身 fetch 失败处理，不误挡合法公网。
  }
  for (const a of addrs) if (ipIsBlocked(a.address)) throw new SsrfError("该链接解析到内网/本机/元数据地址，已拒绝。")
}

// ── 沙箱 argv ──
const ENV_ALLOW = ["LANG", "LC_ALL", "TZ", "TERM"]

function sessionSlug(sessionID: string): string {
  return createHash("sha256").update(sessionID || "anon").digest("hex").slice(0, 16)
}

/** 每会话私有 tmp/run 目录（挡 L12 跨租户 /tmp/.run）。 */
export function sessionTmpDir(sessionID: string): string {
  return path.join(RUN_ROOT, sessionSlug(sessionID), "tmp")
}
export function sessionRunDir(sessionID: string): string {
  return path.join(RUN_ROOT, sessionSlug(sessionID), "run")
}

function sandboxEnv(): string[] {
  const args: string[] = ["--clearenv"]
  const set = (k: string, v: string) => args.push("--setenv", k, v)
  set("PATH", "/opt/agent-harness/bin:/usr/local/bin:/usr/bin:/bin")
  set("HOME", WORKSPACE)
  set("TMPDIR", "/tmp")
  set("PYTHONDONTWRITEBYTECODE", "1")
  for (const k of ENV_ALLOW) {
    const v = process.env[k]
    if (v) set(k, v)
  }
  if (!process.env.LANG) set("LANG", "C.UTF-8")
  return args
}

function maskArgs(): string[] {
  const args: string[] = []
  const tmpfsIfDir = (p: string) => {
    if (existsSync(p)) args.push("--tmpfs", p)
  }
  tmpfsIfDir(path.join(WORKSPACE, ".local/share/opencode"))
  tmpfsIfDir(path.join(WORKSPACE, ".opencode-state"))
  const oc = path.join(WORKSPACE, ".opencode")
  if (existsSync(oc)) {
    args.push("--tmpfs", oc)
    for (const sub of ["skills", "lib", "node_modules"]) {
      const p = path.join(oc, sub)
      if (existsSync(p)) args.push("--ro-bind", p, p)
    }
  }
  // .run 整体遮掉（其他会话的 tmp/run 不可见）；本会话的在 uploadArgs 之后单独挂回。
  if (existsSync(RUN_ROOT)) args.push("--tmpfs", RUN_ROOT)
  return args
}

function uploadArgs(sessionID: string): string[] {
  if (!existsSync(UPLOADS)) return []
  const args: string[] = ["--tmpfs", UPLOADS]
  for (const id of allowedUploads(sessionID)) {
    const p = path.join(UPLOADS, id)
    if (existsSync(p)) args.push("--bind", p, p)
  }
  return args
}

export function sandboxAvailable(): boolean {
  return existsSync(BWRAP)
}

/** bwrap argv（不含 --chdir）＋已正规化的 cwd；launcher 与 sandboxPrefix 共用同一份真源。 */
function sandboxArgv(opts: { sessionID: string; cwd?: string }): { argv: string[]; cwd: string } {
  const tmp = sessionTmpDir(opts.sessionID)
  const run = sessionRunDir(opts.sessionID)
  const cwdReal = opts.cwd ? safeResolve(opts.cwd) : run
  const cwd = withinWorkspace(cwdReal) ? cwdReal : run
  const extraOpt: string[] = []
  for (const p of ["/opt/agent-harness/bin"]) if (existsSync(p)) extraOpt.push("--ro-bind", p, p)
  const argv = [
    BWRAP,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/home",
    "--tmpfs", "/root",
    "--tmpfs", "/opt",
    ...extraOpt,
    "--bind", WORKSPACE, WORKSPACE,
    ...maskArgs(),
    ...uploadArgs(opts.sessionID),
    // 本会话私有 tmp/run：挂回 /tmp 与 .run/<slug>（其余会话已被 maskArgs tmpfs 盖掉）。
    "--bind", tmp, "/tmp",
    "--bind", run, path.join(RUN_ROOT, sessionSlug(opts.sessionID), "run"),
    ...sandboxEnv(),
  ]
  return { argv, cwd }
}

export function sandboxPrefix(opts: { sessionID: string; cwd?: string }): string[] {
  const { argv, cwd } = sandboxArgv(opts)
  return [...argv, "--chdir", cwd]
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const LAUNCHER_NAME = "sandbox-exec.sh"

/**
 * launcher 落点：.run/<slug>/launcher/sandbox-exec.sh —— **刻意放在 run/ 之外**。
 * 沙箱内 .run 被 maskArgs 以 tmpfs 遮罩、只把 run/ 绑回去，所以本档在沙箱内不存在，
 * 工具改不到它（若放在 run/ 内，agent 可改写下一轮要执行的脚本＝逃逸后门）。
 */
export function sessionLauncherPath(sessionID: string): string {
  return path.join(RUN_ROOT, sessionSlug(sessionID), "launcher", LAUNCHER_NAME)
}

/** shQuote 的逆运算扫描器：从 i 起读一个单引号字串，支援 '\\'' 转义。 */
function readShQuoted(s: string, i: number): { value: string; next: number } | null {
  if (s[i] !== "'") return null
  let out = ""
  i++
  while (i < s.length) {
    if (s[i] === "'") {
      if (s.slice(i, i + 4) === `'\\''`) {
        out += "'"
        i += 4
        continue
      }
      return { value: out, next: i + 1 }
    }
    out += s[i]
    i++
  }
  return null
}

/** 反解 launcher 呼叫 `exec '<launcher>' '<cwd>' '<cmd>'`（模型复制回显的第二形态）。 */
function unwrapLauncherInvocation(command: string): string | null {
  const head = /^\s*exec\s+/.exec(command)
  if (!head) return null
  let i = head[0].length
  const a = readShQuoted(command, i)
  if (!a || !a.value.endsWith(LAUNCHER_NAME)) return null
  i = a.next
  while (command[i] === " ") i++
  const b = readShQuoted(command, i)
  if (!b) return null
  i = b.next
  while (command[i] === " ") i++
  const c = readShQuoted(command, i)
  if (!c) return null
  return c.value
}

const SELF_WRAP_RE = /(?:^|\s)exec\s+'(?:\/usr\/bin\/)?bwrap'|--die-with-parent/

/**
 * 反解自家沙箱包装层（2026-10-02 事故，子代理连环逾时的单一根因）。
 *
 * `tool.execute.before` 会把 args.command 改写成包装后的命令，而**改写后的 args 就是
 * 落进工具输入纪录、再被回放进模型上下文的那一份**，模型看到后会把整段当命令本体重送：
 *   - 形态一（旧）：exec '<bwrap>' … /bin/bash -c '<命令>' → bwrap 包 bwrap，内层在已被
 *     外层 tmpfs 的 /opt 上重 bind、并引用旧会话 .run/<旧 slug>/{tmp,run}（新会话不存在）
 *     → `bwrap: Can't find source path`，子代理反覆试错直到逾时被杀（DB 可见同调用重送 6×/16×）。
 *   - 形态二（现）：exec '<launcher>' '<cwd>' '<命令>'（见 wrapShellCommand）。
 * 两种形态都剥回最内层原始命令再重新包一次，于是「复制回显重送」正好等于使用者要的原始
 * 命令——巢状在结构上不可能发生。只认自家签名，一般命令零影响。
 */
export function unwrapShellCommand(command: string): string {
  let cur = command
  for (let i = 0; i < 4; i++) {
    const viaLauncher = unwrapLauncherInvocation(cur)
    if (viaLauncher !== null) {
      cur = viaLauncher
      continue
    }
    if (!SELF_WRAP_RE.test(cur)) break
    const marker = "/bin/bash -c "
    const at = cur.lastIndexOf(marker)
    if (at < 0) break
    const payload = cur.slice(at + marker.length).trim()
    if (!/^'[\s\S]*'$/.test(payload)) break
    cur = payload.slice(1, -1).replace(/'\\''/g, "'")
  }
  return cur
}

/**
 * 建立 bwrap `--bind`／launcher 落点所需的宿主目录。容忍已存在（recursive），
 * 不因单一失败而炸（单一失败交给后续 bwrap 以明确错误收场，不在此吞掉整条路径）。
 * mode 0o700：.run 下每个会话目录皆私有；此语义与原 writeSessionLauncher 的 launcher 目录一致
 * （原 wrapShellCommand 的 tmp/run 回圈未给 mode，两者在此收敛为同一份实作）。
 */
function ensureHostDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* 交给后续 bwrap 报错（fail-closed，不静默成功） */
  }
}

/**
 * 确保 sandboxArgv 会 bind 的宿主来源（sessionTmpDir、sessionRunDir）与 launcher 目录都存在。
 * **单一真源**：plugin 的 tool.execute.before 与 writeSessionLauncher 都呼叫本函式——谁产生
 * launcher／谁启动 shell，谁就保证 launcher 执行时需要的宿主目录都在（裸 shell 端点不经
 * tool.execute.before，先前因目录逻辑只长在那里而全数失败）。
 * 必须在 sandboxArgv() 之前呼叫：maskArgs 依 RUN_ROOT 是否存在决定是否挂 `--tmpfs RUN_ROOT`。
 */
export function ensureSessionDirs(sessionID: string): void {
  ensureHostDir(sessionTmpDir(sessionID))
  ensureHostDir(sessionRunDir(sessionID))
  ensureHostDir(path.dirname(sessionLauncherPath(sessionID)))
}

/**
 * 写出（或更新）本会话沙箱启动器。内容只依赖会话与当下档案系统状态（上传白名单可能在
 * 会话中途变动），故每次呼叫重写；以 tmp+rename 原子替换，避免同会话并发 bash 读到半截档。
 */
function writeSessionLauncher(opts: { sessionID: string; cwd?: string }): { file: string; cwd: string; argv: string[] } {
  // 谁产生 launcher，谁保证 launcher 执行时需要的所有宿主目录（tmp / run / launcher 目录）都在。
  ensureSessionDirs(opts.sessionID)
  const { argv, cwd } = sandboxArgv(opts)
  const file = sessionLauncherPath(opts.sessionID)
  const script =
    "#!/bin/sh\n" +
    `# 自动生成（每次呼叫重写）：会话 ${sessionSlug(opts.sessionID)} 的沙箱启动器。\n` +
    "# 沙箱内看不到本档（.run 被 tmpfs 遮罩），故工具无法改写它。\n" +
    `exec ${argv.map(shQuote).join(" ")} --chdir "$1" /bin/bash -c "$2"\n`
  const tmpFile = `${file}.${process.pid}.tmp`
  writeFileSync(tmpFile, script)
  chmodSync(tmpFile, 0o755)
  renameSync(tmpFile, file)
  return { file, cwd, argv }
}

/**
 * 方案 B（2026-10-02）用：只写好本会话 launcher 并回传其绝对路径，不改写任何命令。
 * 由 plugin 的 `shell.env` hook 呼叫——沙箱改在 **spawn 当下** 由顶层 shell 包装器
 * （lib/eimu-shell）注入，args／模型上下文永远只有原始命令。
 *
 * 注：launcher 内容用 `--chdir "$1"`（执行时由包装器传入的 cwd），故这里的 cwd 不影响
 * 沙箱 argv（保留参数是为了与 wrapShellCommand 共用同一份 sandboxArgv 真源）。
 *
 * 保证：本函式会先建好 launcher 执行时所需的所有宿主目录（tmp / run / launcher 目录，
 * 见 ensureSessionDirs）——裸 shell 端点不经 tool.execute.before 也能直接执行，不再 fail-closed。
 */
export function ensureSessionLauncher(sessionID: string, cwd?: string): string {
  return writeSessionLauncher({ sessionID, cwd }).file
}

export function wrapShellCommand(command: string, opts: { sessionID: string; cwd?: string }): string {
  // 目录建立已收敛进 writeSessionLauncher → ensureSessionDirs（单一真源，两条路径共用）。
  const { file, cwd } = writeSessionLauncher(opts)
  // 被记录／回放的只有这一行的长度（~150 字元），bwrap 全文不再进模型上下文。
  return `exec ${shQuote(file)} ${shQuote(cwd)} ${shQuote(unwrapShellCommand(command))}`
}

// ── 秘密值遮罩 ──
const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|HMAC|CREDENTIAL|COOKIE|AUTH)/i
let secretCache: string[] | null = null

function collectSecrets(): string[] {
  const out = new Set<string>()
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && SECRET_NAME_RE.test(k)) out.add(v)
  }
  try {
    const raw = readFileSync(path.join(WORKSPACE, ".opencode/opencode.json"), "utf8")
    for (const m of raw.matchAll(/"apiKey"\s*:\s*"([^"]{8,})"/g)) out.add(m[1])
  } catch {
    /* env-only */
  }
  return [...out].sort((a, b) => b.length - a.length)
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\btvly-[A-Za-z0-9_-]{12,}/g,
  /\bghp_[A-Za-z0-9]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

export function redactSecrets(text: string): string {
  if (!text) return text
  secretCache ??= collectSecrets()
  let out = text
  for (const s of secretCache) if (s && out.includes(s)) out = out.split(s).join("[REDACTED]")
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]")
  return out
}

// 抹除工具输出/网页/附件文本里伪造的网关凭证 token（MEDIUM-2）：合法 ⟦gw:nonce⟧ 只由网关
// 注入 system／user 尾端，工具输出里出现一律是伪造，直接缴械（纵深防御，补 authorityRule 之下）。
const FORGED_GW_TOKEN_RE = /⟦\s*gw\s*:[^⟧]*⟧/gi
export function stripForgedAuthorityTokens(text: string): string {
  if (!text || !text.includes("⟦")) return text
  return text.replace(FORGED_GW_TOKEN_RE, "⟦已移除⟧")
}

/**
 * SSRF-safe fetch：初始 URL 与每个重定向 Location 逐跳过 assertSafeFetchUrl（解析后 IP 覆判），
 * redirect 一律 manual 自行复验——挡「公网 URL 302→内网」（MEDIUM-1）。
 * 只用于下载「用户提供的 URL」；上游 API／平台可信端点不要用本函式（它们可能合法指向内网）。
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url=rawUrl
  let headers=new Headers(init.headers)
  for(let hop=0;hop<=maxRedirects;hop++) {
    await assertSafeFetchUrl(url)
    const target=new URL(url)
    if(target.username||target.password)throw new SsrfError("公开媒体URL不接受嵌入凭证。")
    const host=target.hostname.replace(/^\[|\]$/g,"")
    // 复验并钉住本次连接IP；不能检查DNS一次再让fetch第二次解析造成rebind。
    const records=await dnsLookup(host,{all:true})
    if(!records.length||records.some(record=>ipIsBlocked(record.address)))throw new SsrfError("媒体目标解析到受限网络，已拒绝。")
    const response=await new Promise<Response>((resolve,reject)=>{
      const request=(target.protocol==="https:"?httpsRequest:httpRequest)(target,{
        method:init.method??"GET",headers:Object.fromEntries(headers.entries()),signal:init.signal??undefined,
        lookup:(_hostname:any,options:any,callback:any)=>options?.all?callback(null,records):callback(null,records[0].address,records[0].family),
      },incoming=>{
        const responseHeaders=new Headers()
        for(const [name,value] of Object.entries(incoming.headers)) {
          if(Array.isArray(value))for(const item of value)responseHeaders.append(name,item)
          else if(value!=null)responseHeaders.set(name,value)
        }
        const status=incoming.statusCode??502
        const empty=[204,205,304].includes(status)||(init.method??"GET").toUpperCase()==="HEAD"
        const coding=responseHeaders.get("content-encoding")?.toLowerCase()
        const decode=coding==="gzip"?createGunzip():coding==="deflate"?createInflate():coding==="br"?createBrotliDecompress():null
        const stream=decode?incoming.pipe(decode):incoming
        if(decode){responseHeaders.delete("content-encoding");responseHeaders.delete("content-length");decode.on("close",()=>incoming.destroy())}
        resolve(new Response(empty?null:Readable.toWeb(stream) as any,{status,headers:responseHeaders}))
        if(empty)incoming.resume()
      })
      request.on("error",reject)
      request.setTimeout(90000,()=>request.destroy(new Error("公开媒体连接超时。")))
      if(init.body!=null) {
        if(typeof init.body==="string"||init.body instanceof Uint8Array)request.end(init.body)
        else {request.destroy();reject(new Error("安全媒体下载仅支持字符串或字节请求体。"))}
      } else request.end()
    })
    if(response.status>=300&&response.status<400) {
      const location=response.headers.get("location")
      if(location) {
        await response.body?.cancel().catch(()=>{})
        const next=new URL(location,url)
        if(next.origin!==target.origin) {headers.delete("authorization");headers.delete("cookie");headers.delete("proxy-authorization");headers.delete("host")}
        url=next.toString();continue
      }
    }
    return response
  }
  throw new SsrfError("重定向次数过多，已拒绝。")
}

export function filterForeignUploads(text: string, sessionID: string): string {
  if (!text || !text.includes("uploads/")) return text
  const allow = allowedUploads(sessionID)
  return text
    .split("\n")
    .filter((line) => {
      for (const m of line.matchAll(/uploads\/([0-9a-f-]{36})/gi)) if (!allow.has(m[1].toLowerCase())) return false
      return true
    })
    .join("\n")
}

/**
 * 从任意 args 物件收集所有 http(s) URL 字串值（供 plugin 对 fetch 类工具做 SSRF 前置检查）。
 * 不再靠参数 key 名白名单（url|uri|src…）过滤——那会漏掉 `source` 这类不含 hint 的栏位
 * （HIGH-1：video_evidence.source 曾因此完全绕过 SSRF 闸）。任何看起来是 http(s) 的字串一律过闸；
 * 合法公网 URL 不受影响（闸只挡私网/metadata）。
 */
export function collectUrlArgs(args: unknown): string[] {
  const out: string[] = []
  const visit = (v: unknown) => {
    if (typeof v === "string") {
      if (/^https?:\/\//i.test(v.trim())) out.push(v.trim())
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x)
    } else if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val)
    }
  }
  visit(args)
  return out
}

export function uploadsDirCount(): number {
  try {
    return readdirSync(UPLOADS).length
  } catch {
    return 0
  }
}

export { UUID_RE }
