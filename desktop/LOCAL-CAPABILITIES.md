# Eimu 桌面壳本地能力契约（window.eimuLocal）

> W3 交付。后续工作包（W4 重算卸载、W6 device bridge）依此契约。**能力宁可少，攻击面必须小。**
> 只在 `https://www.eimu.dev` / `https://eimu.dev` 的**顶层 frame** 可用；子视窗不注入本 preload。
> 成功回值；失败一律 `throw Error`，`message` = `"<CODE>: <detail>"`，并尽量带 `err.code`。

## 介面

### `capabilities(): Promise<{ ffmpeg: boolean; version: string; platform: string }>`
探测本机 ffmpeg。`version` 为 `ffmpeg -version` 首行（≤200 字元）；找不到时 `ffmpeg:false, version:""`。

### `pickFiles(opts?): Promise<string[]>`
开原生挑档对话框；**这是唯一授权入口**。回传使用者主动挑选的绝对路径（取消回 `[]`）。
敏感路径（denylist）即使被挑选也**不会**进入授权集、也不会回传。
`opts = { kind?: 'files'|'directory' (预设 files), multiple?: boolean (预设 true), filters?: [{name, extensions:[string]}] }`

### `probe(filePath): Promise<ProbeResult>`
`ProbeResult = { path: string, format: string|null, durationSec: number|null, sizeBytes: number|null, streams: { index, codecType, codecName, width, height, channels, sampleRate }[] }`
`path` 是 realpath（已解 symlink）。

### `extractFrames(filePath, plan?): Promise<Array<{ tSec: number, path: string }>>`
抽帧写入本进程管理的临时目录（`<os.tmp>/eimu-local-output/frames-*/`），回传每个时间点与影像**档案路径**。
（契约栏位为 `path` 而非 `dataUrlOrPath`：避免把每帧 base64 塞进 IPC／记忆体。）
`plan = { count?: 1..24 (预设 8，等距取样), timesSec?: number[] (1..24 个，0..86400 秒，给了就覆写 count), maxWidth?: 16..7680 (预设 720) }`

### `transcode(filePath, opts?): Promise<{ outputPath: string }>`
本机 ffmpeg 转码，回输出档绝对路径。预设输出到 `<os.tmp>/eimu-local-output/<name>.eimu.<hex>.<fmt>`。
`opts = { format?: 'mp4'|'webm'|'mkv'|'mov' (预设 mp4), videoCodec?: 'libx264'|'libx265'|'libvpx-vp9'|'h264_nvenc'|'hevc_nvenc', preset?: 标准 x264 preset, crf?: 0..51, audioCodec?: 'aac'|'libopus'|'mp3'|'copy', audioBitrateKbps?: 32..512, maxWidth?: 16..7680, maxHeight?: 16..4320, copy?: boolean, faststart?: boolean, outputPath?: string, timeoutMs?: 1000..600000 (预设 300000) }`
`outputPath` 若给了，必须落在已授权目录内，否则拒。非白名单的 codec/preset 值一律拒（不静默丢弃）。

### `authorizedRoots(): Promise<string[]>`
目前已授权的根目录（绝对路径 realpath）。由 `pickFiles` 逐次累积，进程内存、重启即清空。

### `bridge.status(): Promise<BridgeStatus>`
`BridgeStatus = { enabled: boolean, state: string, roots: string[], deviceId: string|null, lastError?: string }`
`enabled`＝使用者是否已开启本机档案授权；`state` ∈ `"off"|"no_authorized_roots"|"credentials_unavailable"|"connecting"|"online"|"reconnecting"|"error"`。

### `bridge.enable(): Promise<BridgeStatus>`
使用者已同意；以**当前授权根**启动（或重启）bridge。若尚无授权根 ⇒ **不启动、不自动授权任何
路径**，回 `state:"no_authorized_roots"`（前端据此引导先 `pickFiles({kind:"directory"})` 挑资料夹；
之后授权新根会自动以新 roots 重注册）。

### `bridge.disable(): Promise<BridgeStatus>`
停止 bridge 并记住「使用者关闭」（持久化到 `<userData>/settings.json`）。

### `onBridgeStatus(cb: (status: BridgeStatus) => void): () => void`
订阅状态变化（`eimu-local:bridge-state`）；回传取消订阅函式。

## 错误码
`E_UNTRUSTED_ORIGIN` 来源不在 APP_HOSTS／非顶层 frame｜`E_NOT_AUTHORIZED` 未经 pickFiles 授权｜`E_SENSITIVE_PATH` 命中 denylist｜`E_NOT_FOUND`｜`E_BAD_ARGS`／`E_BAD_OPTS` 参数或白名单不合法｜`E_FFMPEG_MISSING`／`E_FFPROBE_MISSING`｜`E_FFMPEG_FAILED`／`E_FFPROBE_FAILED`｜`E_TIMEOUT`｜`E_INTERNAL`。

## 安全模型
1. **origin**：每个 handler 先验 `event.senderFrame.url` 的 host ∈ `{www.eimu.dev, eimu.dev}` 且为顶层 frame，否则 `E_UNTRUSTED_ORIGIN`。
2. **逐次授权**：只有 `pickFiles` 挑选过的档案／目录（存 realpath）进入 `authorizedRoots`；其余一律 `E_NOT_AUTHORIZED`。授权集为**进程内存**，重启即清空。
3. **denylist**：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.config/{gcloud,gh,git,google-chrome,chromium,BraveSoftware,microsoft-edge,Code,Electron}`、`~/.mozilla`、`~/.git-credentials`、`~/.netrc`、`~/.npmrc`、`~/.pgpass`、`~/.bash_history`、`~/.zsh_history`。命中即拒，**即使在授权根之下**。
4. **边界**：路径先 realpath（解 symlink），再 `path.resolve` 后以「root + 分隔符」前缀比对，杜绝 `..` 逃逸与 `allowed-evil` 前缀混淆。
5. **argv 固定**：`spawn(bin, argv, {shell:false})`；argv 由 `lib/policy.js buildFfmpegArgs` 以白名单／数值范围生成，注入字串只会是单一 argv 元素。逾时 `SIGKILL`。
6. **不暴露**：无 `exec`/`spawn`/`shell`、无任意 channel、无 fs 任意路径读写；`nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true` 均未放宽。

## 验证边界
纯逻辑（denylist／授权边界／argv 固定／候选表／并发闸）已由 `lib/policy.test.js` 覆盖。device
bridge 四个 IPC 的主进程侧（status 三态／enable 无根不启动／disable／授权根变更→以新 roots
重注册）由 `local-worker-bridge.test.js`（`node --test`，注入间谍 client）覆盖。挑档对话框、真
ffmpeg 抽帧/转码、origin 拒绝的真 IPC 串接、真壳 bridge 连线属 **GUI E2E**，需真人在桌面壳内验证
（本包无显示环境，未验）。新增 IPC 需**重建桌面产物**才会出货。
