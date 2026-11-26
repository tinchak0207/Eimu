import { Behavior, PermissionMode, PermissionReason } from "./permission-policy-types"

// ── 路径安全（safetyCheck，bypass 不可绕） ─────────────────────────────────

export type PathSafetyKind =
  | "safe"
  | "invalid_path"
  | "suspicious_windows_path"
  | "symlink"
  | "settings_file"
  | "shell_rc"
  | "credential_file"
  | "env_file"
  | "control_directory"

export interface PathSafetyResult {
  safe: boolean
  behavior: Behavior
  kind: PathSafetyKind
  reason: PermissionReason
}

const CONTROL_DIR_SEGMENTS = new Set([
  ".git",
  ".claude",
  ".ssh",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
])

export const SHELL_RC_BASENAMES = new Set([
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".kshrc",
  ".envrc",
  ".cshrc",
  ".tcshrc",
  ".config/fish/config.fish",
])

const SETTINGS_BASENAMES = new Set([
  "settings.json",
  "settings.local.json",
  "managed-settings.json",
])

/** 凭证/身份设档：改动可改写 git/npm 身份或注入 registry token。 */
export const CREDENTIAL_BASENAMES = new Set([
  ".gitconfig",
  ".npmrc",
  ".netrc",
  ".pgpass",
  ".pypirc",
  ".dockerconfigjson",
])

/** fish 的 functions 目录下的档会在每个 shell 启动时被 source。 */
export function isFishFunctionPath(path: string): boolean {
  const normalized = lower(path)
  return normalized.includes("/.config/fish/functions/") || normalized.startsWith(".config/fish/functions/")
}

export function normalizePathString(path: string): string {
  return path.replace(/\\/g, "/")
}

function pathSegments(path: string): string[] {
  return normalizePathString(path)
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

export function basenameOf(path: string): string {
  const segments = pathSegments(path)
  return (segments[segments.length - 1] ?? "").toLowerCase()
}

export function lower(path: string): string {
  return normalizePathString(path).toLowerCase()
}

export function isSettingsFile(path: string): boolean {
  const normalized = lower(path).replace(/\/+$/, "")
  const base = basenameOf(normalized)
  const segments = pathSegments(normalized)
  // M1：.claude/settings*.json 一律需确认（含 settings.local.json / settings.foo.json）。
  if (segments.includes(".claude") && /^settings[^/]*\.json$/.test(base)) return true
  if (SETTINGS_BASENAMES.has(base)) {
    if (base !== "settings.json" && base !== "settings.local.json") return true
    return segments.includes(".claude")
  }
  return /\/managed-settings\.d\//.test(`/${normalized}/`)
}

function isShellRc(path: string): boolean {
  const normalized = lower(path)
  const base = basenameOf(normalized)
  if (SHELL_RC_BASENAMES.has(base)) return true
  return normalized.endsWith("/.config/fish/config.fish")
}

export function isEnvFile(path: string): boolean {
  return /^\.env(?:$|[.\-_])/.test(basenameOf(path))
}

function isCredentialFile(path: string): boolean {
  if (CREDENTIAL_BASENAMES.has(basenameOf(path))) return true
  return isFishFunctionPath(path)
}

function hasControlSegment(path: string): boolean {
  const segments = pathSegments(lower(path))
  for (const segment of segments) {
    if (CONTROL_DIR_SEGMENTS.has(segment)) return true
  }
  for (let i = 0; i + 1 < segments.length; i++) {
    if (segments[i] === ".config" && segments[i + 1] === "git") return true
  }
  return false
}

function isSuspiciousWindowsPath(path: string): boolean {
  const normalized = normalizePathString(path)
  if (normalized.startsWith("//?/") || normalized.startsWith("//./")) return true
  if (/^[a-zA-Z]:/.test(normalized) && !/^[a-zA-Z]:\//.test(normalized)) return true
  for (const segment of normalized.split("/")) {
    if (!segment || segment === "." || segment === "..") continue
    if (/[. ]$/.test(segment)) return true
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)) return true
  }
  return false
}

/**
 * 写路径安全判定。mode 只影响回传 reason 的模式标注，不改变安全结论：
 * safetyCheck 在 default/bypassPermissions 下完全一致。
 */
export function checkPathSafety(
  path: unknown,
  mode: PermissionMode = "default",
  options: { symlink?: boolean } = {},
): PathSafetyResult {
  const result = (behavior: Behavior, kind: PathSafetyKind, reason: string): PathSafetyResult => ({
    safe: behavior === "allow",
    behavior,
    kind,
    reason: {
      type: "safetyCheck",
      reason,
      kind,
      mode,
      path: typeof path === "string" ? path : undefined,
      auditSource: "path_gate",
    } as PermissionReason & { kind: PathSafetyKind },
  })

  if (typeof path !== "string" || path.trim().length === 0) {
    return result("deny", "invalid_path", "write path is missing or empty")
  }
  const normalized = normalizePathString(path.trim())

  if (options.symlink) {
    return result("deny", "symlink", "write target is a symbolic link; write to the link target instead")
  }
  if (isSuspiciousWindowsPath(normalized)) {
    return result("deny", "suspicious_windows_path", "write path contains a suspicious Windows path pattern")
  }
  if (isSettingsFile(normalized)) {
    return result("ask", "settings_file", "write target is a permission/settings file and always requires confirmation")
  }
  if (isCredentialFile(normalized)) {
    return result("deny", "credential_file", "write target is a credential/identity file and can leak or hijack credentials")
  }
  if (isShellRc(normalized)) {
    return result("deny", "shell_rc", "write target is a shell startup file and can execute code")
  }
  if (isEnvFile(normalized)) {
    return result("ask", "env_file", "write target is an environment/secret file")
  }
  if (hasControlSegment(normalized)) {
    return result("deny", "control_directory", "write target is inside a control/config directory")
  }
  return result("allow", "safe", "write path passed safety checks")
}
