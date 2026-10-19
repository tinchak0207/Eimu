/**
 * videoCompose — ffmpeg 探测边界抽取（F-SHARDING 片3）。
 *
 * 来源：/home/user/Desktop/kunpeng-vendor src/lib/canvas/videoCompose.ts @ 872a58b。
 * 逐行抽取 L13/L15-48：CommandResult、shellQuote、ffmpegCandidates（候选表第一位
 * `~/.kunpeng/bin/ffmpeg`，VPS 静态二进制落位即命中）、detectFfmpeg。
 * 其余 232 行（浏览器媒体探测/旧画布合成路径，DOM API）不进 harness 主链
 * （F-SHARDING §1.1 分类 C）。
 * invoke/homeDir/isWindowsSync 由片4 tauri-adapter 承接（Bun.spawn bash -lc 同构）。
 */
import { invoke } from '../adapter/tauri-adapter';
import { homeDir } from '../adapter/tauri-adapter';
import { isWindowsSync } from '../adapter/tauri-adapter';

interface CommandResult { stdout: string; stderr: string; exit_code: number }

// Windows：PATH 优先（Git Bash 下 `ffmpeg` 直接命中）+ 常见安装目录。绝对
// 路径预置单引号：bash 会把裸反斜杠当转义、空格会拆词；返回值作为 shell
// 命令片段被各调用点直接内插，引号必须随值一起传递。
// 注意：WebView 里没有 process（Vite 产物中 process.env 被替换为 {}），
// 用户目录必须经 homeDir() 获取，因此候选列表是异步构造的。
const shellQuote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
let ffmpegCandidatesPromise: Promise<string[]> | null = null;
const ffmpegCandidates = (): Promise<string[]> =>
  (ffmpegCandidatesPromise ??= (async () => {
    if (!isWindowsSync()) {
      return ['~/.kunpeng/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', 'ffmpeg'];
    }
    const home = (await homeDir()).replace(/\\/g, '/');
    return [
      'ffmpeg',
      'ffmpeg.exe',
      shellQuote(`${home}.kunpeng/bin/ffmpeg.exe`),
      shellQuote(`${home}AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe`),
      shellQuote('C:/ffmpeg/bin/ffmpeg.exe'),
    ];
  })());

export async function detectFfmpeg(): Promise<string | null> {
  for (const bin of await ffmpegCandidates()) {
    try {
      const r = await invoke<CommandResult>('execute_command', {
        command: `${bin} -version`,
        timeoutMs: 5000,
      });
      if (r.exit_code === 0) return bin;
    } catch { /* try next */ }
  }
  return null;
}
