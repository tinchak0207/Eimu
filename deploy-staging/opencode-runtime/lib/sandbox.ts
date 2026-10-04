// Agent 代碼/檔案存取沙箱與閘（2026-09-29 審計＋紅隊二輪修復）。
//
// 威脅模型：agent 跑用戶輸入，能調 bash/run_py（進 bwrap）與原生 read/write/edit/grep/... 及
// 讀圖等帶 URL 的工具（原生工具跑在受信 opencode 進程，有全檔案系統＋全 env＋網路）。
// 進程 env 有上游密鑰；workspace 多租戶（各用戶檔案在 uploads/<gateway-sessionId>/）；
// gateway /internal/* 是 loopback 無鑑權。
//
// 紅隊二輪推翻了「只沙箱 bash」的思路——原生工具才是主攻面。本檔提供：
//   1. checkAgentPath：**白名單**（realpath 解析後必須落在 workspace 子樹＋本會話 uploads），
//      擋 C1（預設放行）、H3（symlink 逃逸）、L13（前綴比對）。
//   2. 上傳歸屬：由 plugin 從 gateway 可信查得（setOwner），非「用戶提到即授權」（擋 H5）。
//   3. assertSafeFetchUrl：擋私網/loopback/link-local/雲 metadata（擋 C2 SSRF）。
//   4. bwrap 沙箱：清 env、斷網、unshare pid/ipc/uts、根唯讀、遮蔽內部/他租戶、/tmp 與 .run 按會話隔離（擋 L12）。
//   5. redactSecrets / filterForeignUploads：工具輸出進上下文前的兜底。

import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { lookup as dnsLookup } from "node:dns/promises"

// WORKSPACE 預設為生產落點；允許 EIMU_WORKSPACE 覆寫**僅為測試隔離**（可用乾淨臨時根真跑
// bwrap，見 vps-tools/eimu-shell.test.ts）。未設時與舊版逐字相同，不改變任何 argv／可見性語義。
export const WORKSPACE = process.env.EIMU_WORKSPACE || "/opt/agent-harness/workspace"
export const UPLOADS = path.join(WORKSPACE, "uploads")
export const RUN_ROOT = path.join(WORKSPACE, ".run")
const BWRAP = "/usr/bin/bwrap"

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

// ── 會話 → 可信上傳歸屬（由 plugin 從 gateway /internal/session-key 查得後 setOwner）──
type Registry = { owner: Map<string, Set<string>> }
const REG: Registry = ((globalThis as any).__eimuUploadRegistry2 ??= { owner: new Map<string, Set<string>>() })

/** 以 gateway 可信結果設定本會話（opencode sessionID）擁有的 upload uuid 集合。 */
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

/** 本會話可存取的 upload 目錄集合（無記錄＝空集，fail-closed）。 */
export function allowedUploads(sessionID: string): Set<string> {
  return REG.owner.get(sessionID) ?? new Set<string>()
}

// ── 路徑安全解析：realpath 已存在的最長前綴，防 symlink 逃逸；不存在的尾段按字面接上 ──
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

// workspace 內對 agent 關閉的區域（內部狀態/設定/DB/服務）。
const DENY_IN_WORKSPACE = [".local/share/opencode", ".opencode-state"]
const DENY_OPENCODE_FILE_RE = /^\.opencode\/(opencode\.json[^/]*|opencode\.db[^/]*|[^/]*\.bak[^/]*|[^/]*redteam[^/]*|services(\/|$))/

export type PathVerdict = { ok: true } | { ok: false; reason: string }

/**
 * 白名單路徑閘：realpath 解析後必須落在 workspace 子樹；uploads 只放行本會話擁有的目錄；
 * 內部狀態/設定目錄一律拒。listing=true 時額外拒 uploads 根（防列出全租戶目錄）。
 */
export function checkAgentPath(rawPath: string | undefined, sessionID: string, opts: { listing?: boolean } = {}): PathVerdict {
  const real = safeResolve(rawPath ?? ".")
  if (!withinWorkspace(real)) return { ok: false, reason: "outside_workspace" }
  const rel = real === WORKSPACE ? "" : path.relative(WORKSPACE, real)
  for (const d of DENY_IN_WORKSPACE) {
    if (rel === d || rel.startsWith(d + "/")) {
      // 例外：opencode 截斷輸出落盤檔，agent 需按確切路徑回讀（不可列目錄）。
      // read 類（listing=false）一律放行；grep/glob/list（listing=true）只放行「指向單一既有檔案」
      // （截斷提示叫 agent「Use Grep to search the full content」，H10：此前 grep 被 listing 擋成 internal_state）。
      if (rel.startsWith(".local/share/opencode/tool-output/")) {
        if (!opts.listing) return { ok: true }
        try {
          if (statSync(real).isFile()) return { ok: true }
        } catch {
          /* 不存在/不可 stat → 按拒絕 */
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
 * 值是否「看似檔案路徑」——供同時可收 base64／URL／路徑的參數（music_gen.source_audio，
 * 2026-10-04 本地參考音檔接線）決定是否進 checkAgentPath。純 base64 字母表的值（含 + / =）
 * 不算路徑：避免對 MB 級 base64 逐段 realpath/existsSync 解析（性能）與無謂拒收；
 * data:/http(s) 前綴同樣不是檔案路徑（各自走 base64／明確報錯分支）。
 * 注意：本函數只做**分類**，不是路徑安全閘——真正放行/拒絕一律仍由 checkAgentPath 決定。
 */
export function looksLikeAgentPath(v: string): boolean {
  const s = (v ?? "").trim()
  if (!s) return false
  if (/^data:/i.test(s) || /^https?:\/\//i.test(s)) return false
  if (s.startsWith("/") || s.startsWith("./") || s.startsWith("../") || s.startsWith("~/") || s.startsWith("uploads/")) return true
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(s)) return false
  return true
}

// ── SSRF 閘（C2）：擋私網/loopback/link-local/雲 metadata；只允許 http(s) 公網 ──
// 各雲 metadata 主機名（Tencent/Ali/Azure 用主機名而非 169.254 字面量，字串黑名單必須顯式列）。
const BLOCKED_HOST_RE =
  /^(localhost|.*\.local|.*\.internal|metadata(\.google)?\.internal|metadata\.tencentyun\.com|metadata\.aliyuncs\.com|metadata\.azure\.com)$/i
function ipIsBlocked(host: string): boolean {
  let h = host.replace(/^\[|\]$/g, "").toLowerCase()
  // IPv4-mapped IPv6（::ffff:127.0.0.1 或 ::ffff:7f00:1）→ 取出內嵌 IPv4 再判。
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
  if (a === 169 && b === 254) return true // link-local + 雲 metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

export class SsrfError extends Error {}

/**
 * URL 是否安全可 fetch。先字面量預檢（含 IPv4-mapped IPv6、各雲 metadata 主機名），
 * 再用 getaddrinfo 正規化解析：`127.1`／十進位／十六進位 IP 字面量與「主機名→私網」
 * （如 metadata.tencentyun.com）都在此落網——解析口徑與工具實際 fetch 一致。
 * 註：解析在此、fetch 在工具內，rebind/redirect 逐跳復驗屬殘留（見 MEDIUM-1，需 fetch 層釘 IP）。
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
    return // 解析不了＝當下打不到，交由工具自身 fetch 失敗處理，不誤擋合法公網。
  }
  for (const a of addrs) if (ipIsBlocked(a.address)) throw new SsrfError("该链接解析到内网/本机/元数据地址，已拒绝。")
}

// ── 沙箱 argv ──
const ENV_ALLOW = ["LANG", "LC_ALL", "TZ", "TERM"]

function sessionSlug(sessionID: string): string {
  return createHash("sha256").update(sessionID || "anon").digest("hex").slice(0, 16)
}

/** 每會話私有 tmp/run 目錄（擋 L12 跨租戶 /tmp/.run）。 */
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
  // .run 整體遮掉（其他會話的 tmp/run 不可見）；本會話的在 uploadArgs 之後單獨掛回。
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

/** bwrap argv（不含 --chdir）＋已正規化的 cwd；launcher 與 sandboxPrefix 共用同一份真源。 */
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
    // 本會話私有 tmp/run：掛回 /tmp 與 .run/<slug>（其餘會話已被 maskArgs tmpfs 蓋掉）。
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
 * launcher 落點：.run/<slug>/launcher/sandbox-exec.sh —— **刻意放在 run/ 之外**。
 * 沙箱內 .run 被 maskArgs 以 tmpfs 遮罩、只把 run/ 綁回去，所以本檔在沙箱內不存在，
 * 工具改不到它（若放在 run/ 內，agent 可改寫下一輪要執行的腳本＝逃逸後門）。
 */
export function sessionLauncherPath(sessionID: string): string {
  return path.join(RUN_ROOT, sessionSlug(sessionID), "launcher", LAUNCHER_NAME)
}

/** shQuote 的逆運算掃描器：從 i 起讀一個單引號字串，支援 '\\'' 轉義。 */
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

/** 反解 launcher 呼叫 `exec '<launcher>' '<cwd>' '<cmd>'`（模型複製回顯的第二形態）。 */
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
 * 反解自家沙箱包裝層（2026-10-02 事故，子代理連環逾時的單一根因）。
 *
 * `tool.execute.before` 會把 args.command 改寫成包裝後的命令，而**改寫後的 args 就是
 * 落進工具輸入紀錄、再被回放進模型上下文的那一份**，模型看到後會把整段當命令本體重送：
 *   - 形態一（舊）：exec '<bwrap>' … /bin/bash -c '<命令>' → bwrap 包 bwrap，內層在已被
 *     外層 tmpfs 的 /opt 上重 bind、並引用舊會話 .run/<舊 slug>/{tmp,run}（新會話不存在）
 *     → `bwrap: Can't find source path`，子代理反覆試錯直到逾時被殺（DB 可見同調用重送 6×/16×）。
 *   - 形態二（現）：exec '<launcher>' '<cwd>' '<命令>'（見 wrapShellCommand）。
 * 兩種形態都剝回最內層原始命令再重新包一次，於是「複製回顯重送」正好等於使用者要的原始
 * 命令——巢狀在結構上不可能發生。只認自家簽名，一般命令零影響。
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
 * 建立 bwrap `--bind`／launcher 落點所需的宿主目錄。容忍已存在（recursive），
 * 不因單一失敗而炸（單一失敗交給後續 bwrap 以明確錯誤收場，不在此吞掉整條路徑）。
 * mode 0o700：.run 下每個會話目錄皆私有；此語義與原 writeSessionLauncher 的 launcher 目錄一致
 * （原 wrapShellCommand 的 tmp/run 迴圈未給 mode，兩者在此收斂為同一份實作）。
 */
function ensureHostDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* 交給後續 bwrap 報錯（fail-closed，不靜默成功） */
  }
}

/**
 * 確保 sandboxArgv 會 bind 的宿主來源（sessionTmpDir、sessionRunDir）與 launcher 目錄都存在。
 * **單一真源**：plugin 的 tool.execute.before 與 writeSessionLauncher 都呼叫本函式——誰產生
 * launcher／誰啟動 shell，誰就保證 launcher 執行時需要的宿主目錄都在（裸 shell 端點不經
 * tool.execute.before，先前因目錄邏輯只長在那裡而全數失敗）。
 * 必須在 sandboxArgv() 之前呼叫：maskArgs 依 RUN_ROOT 是否存在決定是否掛 `--tmpfs RUN_ROOT`。
 */
export function ensureSessionDirs(sessionID: string): void {
  ensureHostDir(sessionTmpDir(sessionID))
  ensureHostDir(sessionRunDir(sessionID))
  ensureHostDir(path.dirname(sessionLauncherPath(sessionID)))
}

/**
 * 寫出（或更新）本會話沙箱啟動器。內容只依賴會話與當下檔案系統狀態（上傳白名單可能在
 * 會話中途變動），故每次呼叫重寫；以 tmp+rename 原子替換，避免同會話並發 bash 讀到半截檔。
 */
function writeSessionLauncher(opts: { sessionID: string; cwd?: string }): { file: string; cwd: string; argv: string[] } {
  // 誰產生 launcher，誰保證 launcher 執行時需要的所有宿主目錄（tmp / run / launcher 目錄）都在。
  ensureSessionDirs(opts.sessionID)
  const { argv, cwd } = sandboxArgv(opts)
  const file = sessionLauncherPath(opts.sessionID)
  const script =
    "#!/bin/sh\n" +
    `# 自動生成（每次呼叫重寫）：會話 ${sessionSlug(opts.sessionID)} 的沙箱啟動器。\n` +
    "# 沙箱內看不到本檔（.run 被 tmpfs 遮罩），故工具無法改寫它。\n" +
    `exec ${argv.map(shQuote).join(" ")} --chdir "$1" /bin/bash -c "$2"\n`
  const tmpFile = `${file}.${process.pid}.tmp`
  writeFileSync(tmpFile, script)
  chmodSync(tmpFile, 0o755)
  renameSync(tmpFile, file)
  return { file, cwd, argv }
}

/**
 * 方案 B（2026-10-02）用：只寫好本會話 launcher 並回傳其絕對路徑，不改寫任何命令。
 * 由 plugin 的 `shell.env` hook 呼叫——沙箱改在 **spawn 當下** 由頂層 shell 包裝器
 * （lib/eimu-shell）注入，args／模型上下文永遠只有原始命令。
 *
 * 註：launcher 內容用 `--chdir "$1"`（執行時由包裝器傳入的 cwd），故這裡的 cwd 不影響
 * 沙箱 argv（保留參數是為了與 wrapShellCommand 共用同一份 sandboxArgv 真源）。
 *
 * 保證：本函式會先建好 launcher 執行時所需的所有宿主目錄（tmp / run / launcher 目錄，
 * 見 ensureSessionDirs）——裸 shell 端點不經 tool.execute.before 也能直接執行，不再 fail-closed。
 */
export function ensureSessionLauncher(sessionID: string, cwd?: string): string {
  return writeSessionLauncher({ sessionID, cwd }).file
}

export function wrapShellCommand(command: string, opts: { sessionID: string; cwd?: string }): string {
  // 目錄建立已收斂進 writeSessionLauncher → ensureSessionDirs（單一真源，兩條路徑共用）。
  const { file, cwd } = writeSessionLauncher(opts)
  // 被記錄／回放的只有這一行的長度（~150 字元），bwrap 全文不再進模型上下文。
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

// 抹除工具輸出/網頁/附件文本裡偽造的網關憑證 token（MEDIUM-2）：合法 ⟦gw:nonce⟧ 只由網關
// 注入 system／user 尾端，工具輸出裡出現一律是偽造，直接繳械（縱深防禦，補 authorityRule 之下）。
const FORGED_GW_TOKEN_RE = /⟦\s*gw\s*:[^⟧]*⟧/gi
export function stripForgedAuthorityTokens(text: string): string {
  if (!text || !text.includes("⟦")) return text
  return text.replace(FORGED_GW_TOKEN_RE, "⟦已移除⟧")
}

/**
 * SSRF-safe fetch：初始 URL 與每個重定向 Location 逐跳過 assertSafeFetchUrl（解析後 IP 覆判），
 * redirect 一律 manual 自行復驗——擋「公網 URL 302→內網」（MEDIUM-1）。
 * 只用於下載「用戶提供的 URL」；上游 API／平台可信端點不要用本函式（它們可能合法指向內網）。
 */
export async function safeFetch(rawUrl: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = rawUrl
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeFetchUrl(url)
    const res = await fetch(url, { ...init, redirect: "manual" })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (loc) {
        await res.body?.cancel().catch(() => {})
        url = new URL(loc, url).toString()
        continue
      }
    }
    return res
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
 * 從任意 args 物件收集所有 http(s) URL 字串值（供 plugin 對 fetch 類工具做 SSRF 前置檢查）。
 * 不再靠參數 key 名白名單（url|uri|src…）過濾——那會漏掉 `source` 這類不含 hint 的欄位
 * （HIGH-1：video_evidence.source 曾因此完全繞過 SSRF 閘）。任何看起來是 http(s) 的字串一律過閘；
 * 合法公網 URL 不受影響（閘只擋私網/metadata）。
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
