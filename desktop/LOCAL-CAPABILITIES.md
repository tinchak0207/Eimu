# Eimu 桌面殼本地能力契約（window.eimuLocal）

> W3 交付。後續工作包（W4 重算卸載、W6 device bridge）依此契約。**能力寧可少，攻擊面必須小。**
> 只在 `https://www.eimu.dev` / `https://eimu.dev` 的**頂層 frame** 可用；子視窗不注入本 preload。
> 成功回值；失敗一律 `throw Error`，`message` = `"<CODE>: <detail>"`，並盡量帶 `err.code`。

## 介面

### `capabilities(): Promise<{ ffmpeg: boolean; version: string; platform: string }>`
探測本機 ffmpeg。`version` 為 `ffmpeg -version` 首行（≤200 字元）；找不到時 `ffmpeg:false, version:""`。

### `pickFiles(opts?): Promise<string[]>`
開原生挑檔對話框；**這是唯一授權入口**。回傳使用者主動挑選的絕對路徑（取消回 `[]`）。
敏感路徑（denylist）即使被挑選也**不會**進入授權集、也不會回傳。
`opts = { kind?: 'files'|'directory' (預設 files), multiple?: boolean (預設 true), filters?: [{name, extensions:[string]}] }`

### `probe(filePath): Promise<ProbeResult>`
`ProbeResult = { path: string, format: string|null, durationSec: number|null, sizeBytes: number|null, streams: { index, codecType, codecName, width, height, channels, sampleRate }[] }`
`path` 是 realpath（已解 symlink）。

### `extractFrames(filePath, plan?): Promise<Array<{ tSec: number, path: string }>>`
抽幀寫入本進程管理的臨時目錄（`<os.tmp>/eimu-local-output/frames-*/`），回傳每個時間點與影像**檔案路徑**。
（契約欄位為 `path` 而非 `dataUrlOrPath`：避免把每幀 base64 塞進 IPC／記憶體。）
`plan = { count?: 1..24 (預設 8，等距取樣), timesSec?: number[] (1..24 個，0..86400 秒，給了就覆寫 count), maxWidth?: 16..7680 (預設 720) }`

### `transcode(filePath, opts?): Promise<{ outputPath: string }>`
本機 ffmpeg 轉碼，回輸出檔絕對路徑。預設輸出到 `<os.tmp>/eimu-local-output/<name>.eimu.<hex>.<fmt>`。
`opts = { format?: 'mp4'|'webm'|'mkv'|'mov' (預設 mp4), videoCodec?: 'libx264'|'libx265'|'libvpx-vp9'|'h264_nvenc'|'hevc_nvenc', preset?: 標準 x264 preset, crf?: 0..51, audioCodec?: 'aac'|'libopus'|'mp3'|'copy', audioBitrateKbps?: 32..512, maxWidth?: 16..7680, maxHeight?: 16..4320, copy?: boolean, faststart?: boolean, outputPath?: string, timeoutMs?: 1000..600000 (預設 300000) }`
`outputPath` 若給了，必須落在已授權目錄內，否則拒。非白名單的 codec/preset 值一律拒（不靜默丟棄）。

## 錯誤碼
`E_UNTRUSTED_ORIGIN` 來源不在 APP_HOSTS／非頂層 frame｜`E_NOT_AUTHORIZED` 未經 pickFiles 授權｜`E_SENSITIVE_PATH` 命中 denylist｜`E_NOT_FOUND`｜`E_BAD_ARGS`／`E_BAD_OPTS` 參數或白名單不合法｜`E_FFMPEG_MISSING`／`E_FFPROBE_MISSING`｜`E_FFMPEG_FAILED`／`E_FFPROBE_FAILED`｜`E_TIMEOUT`｜`E_INTERNAL`。

## 安全模型
1. **origin**：每個 handler 先驗 `event.senderFrame.url` 的 host ∈ `{www.eimu.dev, eimu.dev}` 且為頂層 frame，否則 `E_UNTRUSTED_ORIGIN`。
2. **逐次授權**：只有 `pickFiles` 挑選過的檔案／目錄（存 realpath）進入 `authorizedRoots`；其餘一律 `E_NOT_AUTHORIZED`。授權集為**進程內存**，重啟即清空。
3. **denylist**：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.config/{gcloud,gh,git,google-chrome,chromium,BraveSoftware,microsoft-edge,Code,Electron}`、`~/.mozilla`、`~/.git-credentials`、`~/.netrc`、`~/.npmrc`、`~/.pgpass`、`~/.bash_history`、`~/.zsh_history`。命中即拒，**即使在授權根之下**。
4. **邊界**：路徑先 realpath（解 symlink），再 `path.resolve` 後以「root + 分隔符」前綴比對，杜絕 `..` 逃逸與 `allowed-evil` 前綴混淆。
5. **argv 固定**：`spawn(bin, argv, {shell:false})`；argv 由 `lib/policy.js buildFfmpegArgs` 以白名單／數值範圍生成，注入字串只會是單一 argv 元素。逾時 `SIGKILL`。
6. **不暴露**：無 `exec`/`spawn`/`shell`、無任意 channel、無 fs 任意路徑讀寫；`nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true` 均未放寬。

## 驗證邊界
純邏輯（denylist／授權邊界／argv 固定／候選表／併發閘）已由 `lib/policy.test.js` 覆蓋。挑檔對話框、真 ffmpeg 抽幀/轉碼、origin 拒絕、IPC 串接屬 **GUI E2E**，需真人在桌面殼內驗證（本包無顯示環境，未驗）。
