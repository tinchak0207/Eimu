/**
 * tauri-adapter — Tauri IPC 命令面的 Bun 替身（F-SHARDING 片4，白名单核心）。
 *
 * 语义基准（kunpeng-vendor @ 872a58b，逐点对照）：
 *   - src-tauri/src/tools/bash.rs：execute_command / kill_command
 *   - src-tauri/src/commands.rs：get_home_dir / ensure_workspace
 *   - src-tauri/src/tools/file_ops.rs：append_file
 *   - @tauri-apps/api：tauri.invoke / fs.createDir|exists|removeDir / path.homeDir
 *   - src/lib/platform.ts：userAgentPlatform / isWindowsSync / stopBackgroundProcessCommand
 *
 * 白名单改写（F-SHARDING §2/§3/§4 片4 明文，逐笔见 PATCHES.md）：
 *   1. 命令执行通道：/bin/zsh -c（Rust tokio Command）→ Bun.spawn(['bash','-lc',cmd])，
 *      返回 { stdout, stderr, exit_code } 同构（前端本地 CommandResult 只消费这三字段）。
 *   2. timeoutMs → 自管 timer SIGKILL 树杀，超时 reject 对齐 vendor
 *      「Command timed out after Nms」；缺省 120000ms（bash.rs unwrap_or(120_000)）。
 *   3. kill_command → 进程表 SIGKILL（vendor 为进程组 TERM→1.5s→KILL；Bun.spawn 无
 *      process_group(0)，树杀走 platform.ts 同款 pkill -P 公式）。
 *   4. get_home_dir / homeDir → process.env.HOME（vendor dirs::home_dir）。
 *   5. ensure_workspace → env KUNPENG_WORKSPACE 可覆写，默认
 *      /opt/eimu-harness/workspace/kunpeng（vendor 为 ~/.kunpeng/workspace/YYYY-MM-DD/
 *      日期分桶 + images/code/docs/videos 四子目录，harness 场景不做日期分桶）。
 *   6. createDir / exists / removeDir → node:fs/promises（@tauri-apps/api/fs 同签名子集）。
 *   7. platform 替身：userAgentPlatform 固定 'linux'（vendor 走 navigator.userAgent）。
 *
 * 未替身命令一律诚实抛错（对齐 fxRenderStub 的诚实边界风格）。
 */
import { mkdir, access, rm, appendFile } from 'node:fs/promises';
// ffmpeg/ffprobe 全域限流（VPS OOM 治本，2026-10-02）：所有经 invoke("execute_command")
// 的 ffmpeg 执行共用一个进程级讯号量，满载/记忆体不足时排队而非全开。
import { shouldThrottleFfmpeg, acquireFfmpegSlot, releaseFfmpegSlot } from '../../ffmpeg-limiter';

interface CommandResult { stdout: string; stderr: string; exit_code: number }

// ── Bun 全局最小类型面 ───────────────────────────────────────────────────────
// harness 运行时为 Bun 1.3.x（VPS /home/ubuntu/.bun/bin/bun）。本仓 tsc 无
// bun-types，这里只声明适配器实际消费的子集；运行时由真 Bun 或本地实弹脚本
// 的 node:child_process 同构注入满足。
type BunSpawnOptions = {
  stdin?: 'ignore' | 'inherit';
  stdout?: 'pipe' | 'ignore' | 'inherit';
  stderr?: 'pipe' | 'ignore' | 'inherit';
  cwd?: string;
};
type BunSpawnProc = {
  pid: number;
  exitCode: number | null;
  exited: Promise<number | null>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number | string): void;
};
declare const Bun: { spawn(command: string[], options?: BunSpawnOptions): BunSpawnProc };

// ── 进程表（requestId → pid），对应 bash.rs 的 BashProcessState.active ──────
// vendor 用 RAII PidGuard 在命令结束时摘除；这里在 execute_command 的
// finally 中同步删除，语义相同。
const activeProcs = new Map<string, number>();

/**
 * 树杀一条龙：Bun.spawn 无 process_group(0)，vendor killpg(SIGKILL) 在此
 * 等价改写为 platform.ts 的 Unix 分支公式（pkill -KILL -P 先杀直接子进程，
 * 再 kill -KILL 父；顺序保证子进程 reparent 前可寻址）。单条 bash 内原子
 * 顺序执行，fire-and-forget。
 */
function killTree(pid: number): void {
  const cmd = stopBackgroundProcessCommand(String(pid), true);
  try {
    Bun.spawn(['bash', '-lc', cmd], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  } catch { /* 父进程已退出等场景，杀不到即目标已死 */ }
}

/** 对齐 bash.rs execute_command：超时缺省 120000ms。 */
async function executeCommand(args: {
  command: string;
  timeoutMs?: number;
  requestId?: string;
  cwd?: string;
}): Promise<CommandResult> {
  const timeoutMs = args.timeoutMs ?? 120_000;
  // ffmpeg 限流：取得执行槽后才 spawn（非 ffmpeg 指令不受影响）。
  const throttled = shouldThrottleFfmpeg(args.command);
  if (throttled) await acquireFfmpegSlot();
  try {
    const proc = Bun.spawn(['bash', '-lc', args.command], {
      stdin: 'ignore', // vendor 继承；gateway 是 systemd 服务 stdin 为 null，显式 ignore 防挂起
      stdout: 'pipe',
      stderr: 'pipe',
      ...(args.cwd ? { cwd: args.cwd } : {}),
    });
    const rid = args.requestId;
    if (rid) activeProcs.set(rid, proc.pid);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc.pid);
    }, timeoutMs);

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      if (timedOut) throw new Error(`Command timed out after ${timeoutMs}ms`);
      // vendor: result.status.code().unwrap_or(-1)——被信号杀（SIGKILL）时为 -1
      const exit_code = proc.exitCode ?? -1;
      return { stdout, stderr, exit_code };
    } finally {
      clearTimeout(timer);
      if (rid) activeProcs.delete(rid);
    }
  } finally {
    if (throttled) releaseFfmpegSlot();
  }
}

/** 对齐 bash.rs kill_command：进程表查 pid，整树 SIGKILL；表内无此 id 时静默 Ok。 */
async function killCommand(requestId: string): Promise<void> {
  const pid = activeProcs.get(requestId);
  if (pid == null) return;
  killTree(pid);
}

/** 对齐 commands.rs get_home_dir：dirs::home_dir() 失败时同文案报错。 */
function getHomeDir(): string {
  const home = process.env.HOME;
  if (!home) throw new Error('Cannot find home directory');
  return home;
}

/** 对齐 @tauri-apps/api/path homeDir（videoCompose 的 Windows 候选分支消费）。 */
export async function homeDir(): Promise<string> {
  return getHomeDir();
}

/**
 * 对齐 commands.rs ensure_workspace（白名单改写）：vendor 建
 * ~/.kunpeng/workspace/YYYY-MM-DD/ + 四子目录；harness 固定工作区
 * /opt/eimu-harness/workspace/kunpeng，env KUNPENG_WORKSPACE 可覆写。
 */
const KUNPENG_WORKSPACE_DEFAULT = '/opt/eimu-harness/workspace/kunpeng';

async function ensureWorkspace(): Promise<string> {
  const workspace = process.env.KUNPENG_WORKSPACE || KUNPENG_WORKSPACE_DEFAULT;
  await mkdir(workspace, { recursive: true });
  return workspace;
}

// ── @tauri-apps/api/fs 同签名子集（composeEngine 消费面）────────────────────

/** 对齐 fs.createDir：recursive 语义同 tauri（缺省 false）。 */
export async function createDir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
  await mkdir(dirPath, { recursive: options?.recursive ?? false });
}

/** 对齐 fs.exists。 */
export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 对齐 fs.removeDir：recursive 语义同 tauri（缺省 false）。 */
export async function removeDir(dirPath: string, options?: { recursive?: boolean }): Promise<void> {
  await rm(dirPath, { recursive: options?.recursive ?? false });
}

/** 对齐 tools/file_ops.rs append_file：先建父目录，再追加写。 */
async function appendFileText(path: string, content: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent) await mkdir(parent, { recursive: true });
  await appendFile(path, content);
}

// ── IPC 分派（@tauri-apps/api/tauri invoke 同签名）──────────────────────────

/**
 * invoke 替身：命令名与参数面与 vendor 前端调用点逐一对应
 * （camelCase args ↔ vendor Rust snake_case 参数，由本层转换）。
 * 未支持的命令诚实抛错。
 */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  switch (cmd) {
    case 'execute_command':
      return executeCommand({
        command: String(args?.command ?? ''),
        timeoutMs: args?.timeoutMs == null ? undefined : Number(args.timeoutMs),
        requestId: args?.requestId == null ? undefined : String(args.requestId),
        cwd: args?.cwd == null ? undefined : String(args.cwd),
      }) as Promise<T>;
    case 'kill_command':
      await killCommand(String(args?.requestId ?? ''));
      return undefined as T;
    case 'get_home_dir':
      return getHomeDir() as T;
    case 'ensure_workspace':
      return ensureWorkspace() as T;
    case 'append_file':
      await appendFileText(String(args?.path ?? ''), String(args?.content ?? ''));
      return undefined as T;
    default:
      throw new Error(`tauri-adapter: 未支持的命令 "${cmd}"（harness 替身面仅 execute_command/kill_command/get_home_dir/ensure_workspace/append_file）`);
  }
}

// ── platform.ts 替身（F-SHARDING §1.1：isWindowsSync()=false，固定 'linux'）──

/**
 * 同步的粗粒度平台判断（不涉及 shell 方言时使用）。
 * 白名单改写：vendor 经 navigator.userAgent 判别；harness 无 WebView，
 * 固定返回 'linux'（方案 §1.1 明文「替身内固定 'linux'」）。
 */
export function userAgentPlatform(): 'macos' | 'windows' | 'linux' {
  return 'linux';
}

/** vendor platform.ts 逐行（依赖上方固定 'linux' 后恒为 false）。 */
export function isWindowsSync(): boolean {
  return userAgentPlatform() === 'windows';
}

/**
 * 生成"终止后台 shell 进程树"的跨平台命令（配合 execute_command 使用）。
 * pid 必须是启动命令（nohup … & echo $!）回读的那个 pid。
 *
 * - Unix：pkill 杀子进程 + kill 杀父进程。
 * - Windows（Git Bash）：先经 /proc/<pid>/winpid 换算出 Windows PID（必须
 *   在 kill 之前读，进程死后 /proc 条目消失、`&&` 短路会让 taskkill 永远
 *   轮不到），再 kill MSYS pid，最后 taskkill /T 连根终止原生进程树；
 *   MSYS2_ARG_CONV_EXCL 阻止 MSYS 把 /PID 参数误转换成路径。Windows 无
 *   进程组信号，force 与否同为强杀。
 *
 * vendor platform.ts 逐行随档（harness 固定走 Unix 分支）。
 */
export function stopBackgroundProcessCommand(pid: string, force: boolean): string {
  const sig = force ? 'KILL' : 'TERM';
  if (isWindowsSync()) {
    return `W=$(cat /proc/${pid}/winpid 2>/dev/null); kill -${sig} ${pid} 2>/dev/null || true; [ -n "$W" ] && MSYS2_ARG_CONV_EXCL='*' taskkill /PID "$W" /T /F >/dev/null 2>&1 || true`;
  }
  return `pkill -${sig} -P ${pid} 2>/dev/null || true; kill -${sig} ${pid} 2>/dev/null || true`;
}
