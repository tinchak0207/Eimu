/**
 * artifactsStub — Tauri 工件注册表替身（F-SHARDING §1.1 B 类替身，片4 落盘）。
 *
 * 来源：kunpeng src/lib/artifacts/index.ts @ 872a58b。
 * 白名单（方案 §1.1 行「appendArtifact」明文）：「替身：no-op / JSONL 日志」——
 * composeEngine 仅两处调用（纯记账），类型块（ArtifactType/ArtifactEntry）与
 * typeFromPath 逐行随档；appendArtifact 改写为 ${HOME}/.kunpeng/artifacts.jsonl
 * 追加（vendor 写 Tauri Home 目录 artifacts-manifest.json，harness 无 Tauri fs）；
 * 串行写队列与 dedupe-by-path 语义保留，失败吞错文案同 vendor。
 * scanner（listArtifacts/scan_dir_meta）为 UI 专用，不随档。
 */
export type ArtifactType = 'image' | 'video' | 'audio' | 'doc' | 'other';

export interface ArtifactEntry {
  path: string;
  type: ArtifactType;
  size: number;
  createdAt: number;
  projectId?: string;
  engine?: string;
  prompt?: string;
  taskId?: string;
  /** true when found by the scanner rather than recorded by the pipeline. */
  scanned?: boolean;
}

const MANIFEST_REL = '.kunpeng/artifacts.jsonl';

export function typeFromPath(path: string): ArtifactType {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (/^(png|jpg|jpeg|webp|gif)$/.test(ext)) return 'image';
  if (/^(mp4|mov|webm)$/.test(ext)) return 'video';
  if (/^(mp3|wav|m4a|flac)$/.test(ext)) return 'audio';
  if (/^(md|txt|pdf|docx|pptx|xlsx)$/.test(ext)) return 'doc';
  return 'other';
}

// ── Manifest (single-writer queue, append semantics) ─────────────────────────
let manifestQueue: Promise<void> = Promise.resolve();

async function readManifest(): Promise<ArtifactEntry[]> {
  try {
    const home = process.env.HOME ?? '';
    if (!home) return [];
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(`${home}/${MANIFEST_REL}`, 'utf8');
    return raw.trim()
      ? raw.trim().split('\n').map((line) => JSON.parse(line) as ArtifactEntry)
      : [];
  } catch {
    return [];
  }
}

export function appendArtifact(entry: Omit<ArtifactEntry, 'size' | 'createdAt'> & { size?: number; createdAt?: number }): Promise<void> {
  const next = manifestQueue.then(async () => {
    const home = process.env.HOME ?? '';
    if (!home) return;
    const manifestPath = `${home}/${MANIFEST_REL}`;
    const { mkdir, appendFile } = await import('node:fs/promises');
    await mkdir(manifestPath.slice(0, manifestPath.lastIndexOf('/')), { recursive: true });
    const entries = await readManifest();
    if (entries.some((e) => e.path === entry.path)) return;
    entries.push({
      size: 0,
      createdAt: Date.now(),
      ...entry,
    });
    await appendFile(manifestPath, `${JSON.stringify(entries[entries.length - 1])}\n`);
  }).catch((err) => console.warn('[artifacts] append failed:', err));
  manifestQueue = next;
  return next;
}
