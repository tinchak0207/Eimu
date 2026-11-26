// 媒体历史投影逐行复用 src/lib/agent-media-history.ts 的稳定 id 与音视频分支。
import Taro from '@tarojs/taro'
import { request } from './request'
import type { HistoryEntry } from './history'
import type { AgentItem } from '../components/agent-chat/types'
type AgentMediaItem = Extract<AgentItem, { kind: 'image' | 'video' | 'audio' }>
function agentMediaId(taskId: string | undefined, url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) hash = (hash * 31 + url.charCodeAt(i)) | 0;
  return `agent-${taskId ?? `u${(hash >>> 0).toString(36)}`}`;
}

export function agentHistoryEntryForMedia(item: AgentMediaItem): HistoryEntry {
  const id = agentMediaId(item.taskId, item.url);
  const taskFields = item.taskId ? { taskId: item.taskId } : {};
  if (item.kind === "image") {
    const modelId = item.recipe?.model || "agent";
    const size = item.recipe?.size;
    return {
      id,
      prompt: item.recipe?.prompt ?? "",
      generatedAt: Date.now(),
      source: "server",
      entryKind: "image",
      modelId,
      ...taskFields,
      results: [
        {
          provider: "primary",
          modelId,
          image: null,
          imageUrl: item.url,
          mediaType: "image",
          ...taskFields,
        },
      ],
      ...(size ? { workflow: { imageSize: size } } : {}),
    };
  }

  if (item.kind === "video") {
    return {
      id,
      prompt: "",
      generatedAt: Date.now(),
      source: "server",
      entryKind: "video",
      modelId: "agent",
      ...taskFields,
      results: [
        {
          provider: "agent",
          modelId: "agent",
          image: null,
          imageUrl: null,
          videoUrl: item.url,
          mediaType: "video",
          ...taskFields,
        },
      ],
    };
  }

  return {
    id,
    prompt: "",
    generatedAt: Date.now(),
    source: "server",
    entryKind: "audio",
    modelId: "agent",
    ...taskFields,
    results: [
      {
        provider: "agent",
        modelId: "agent",
        image: null,
        imageUrl: null,
        audioUrl: item.url,
        mediaType: "audio",
        ...taskFields,
      },
    ],
  };
}
export async function saveAgentMediaToHistory(item: AgentMediaItem): Promise<boolean> {
  try {
    await request({ path: '/api/history', method: 'POST', data: agentHistoryEntryForMedia(item) })
    return true
  } catch { return false }
}
/** DOM 文件下载替换为微信相册/文件分享，只有平台完成才回 true。 */
export async function downloadAgentMedia(item: AgentMediaItem): Promise<boolean> {
  try {
    const file = await Taro.downloadFile({ url: item.url })
    if (file.statusCode !== 200) return false
    if (item.kind === 'image') await Taro.saveImageToPhotosAlbum({ filePath: file.tempFilePath })
    else if (item.kind === 'video') await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
    else {
      const ext = /\.(mp3|m4a|wav|aac|ogg|flac)(?:[?#]|$)/i.exec(item.url)?.[1] ?? 'mp3'
      await Taro.shareFileMessage({ filePath: file.tempFilePath, fileName: `eimu-audio.${ext}` })
    }
    return true
  } catch { return false }
}
