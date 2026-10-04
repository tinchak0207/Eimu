import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// tsconfig 的 jsx=preserve 让 tsx 对 .tsx 退回 classic runtime（React.createElement），
// 而组件源码不 import React（Next 构建走 automatic）。补全局 React 桩（同 agent-chat-ui.test.ts）。
(globalThis as unknown as Record<string, unknown>).React ??= React;

import { AgentImageCard } from "./AgentImageCard";
import { AgentVideoCard } from "./AgentVideoCard";
import { AgentAudioCard } from "./AgentAudioCard";
import type { AgentImageItem, AgentAudioItem, AgentVideoItem } from "@/lib/agent-chat-types";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const imageCardSrc = read("src/components/agent-chat/AgentImageCard.tsx");
const videoCardSrc = read("src/components/agent-chat/AgentVideoCard.tsx");
const audioCardSrc = read("src/components/agent-chat/AgentAudioCard.tsx");
const surfaceSrc = read("src/components/agent-chat/AgentChatSurface.tsx");
const panelSrc = read("src/components/agent-chat/AgentChatPanel.tsx");
const transcriptSrc = read("src/components/agent-chat/AgentTranscript.tsx");

/** 取出某颗按钮的开标签（按 aria-label 定位），用于查 disabled。 */
function buttonTag(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
}

const imageItem: AgentImageItem = {
  kind: "image",
  id: "img-1",
  seq: 1,
  url: "https://store.example.com/jobs/cat.png",
  taskId: "job-img-1",
  recipe: { prompt: "a cat", model: "gpt-image-2", size: "1536x1024" },
};

const videoItem: AgentVideoItem = {
  kind: "video",
  id: "vid-1",
  seq: 2,
  url: "https://store.example.com/jobs/clip.mp4",
  mediaKind: "film",
};

const audioItem: AgentAudioItem = {
  kind: "audio",
  id: "aud-1",
  seq: 3,
  url: "https://store.example.com/jobs/song.m4a",
  mediaKind: "music",
};

test("图卡：配方可重跑时才渲染「再来 N 组／微调变体」，回调缺席 = disabled", () => {
  // 回调给足：文字真的上屏，按钮可点（无 disabled 属性）。
  const wired = renderToStaticMarkup(
    createElement(AgentImageCard, { item: imageItem, onRerun: () => {}, onRerunVariant: () => {} }),
  );
  assert.match(wired, /再来 N 组/);
  assert.match(wired, /微调变体/);
  assert.doesNotMatch(buttonTag(wired, "再来 N 组"), / disabled=""/);
  assert.doesNotMatch(buttonTag(wired, "微调变体"), / disabled=""/);

  // 回调缺席：按钮仍在（可重跑）但 disabled，不伪造行为。
  const unwired = renderToStaticMarkup(createElement(AgentImageCard, { item: imageItem }));
  assert.match(buttonTag(unwired, "再来 N 组"), / disabled=""/);
  assert.match(buttonTag(unwired, "微调变体"), / disabled=""/);
});

test("图卡：配方推不出可计价模型时，两颗钮整组不渲染", () => {
  const noRecipe = renderToStaticMarkup(
    createElement(AgentImageCard, {
      item: { ...imageItem, recipe: undefined },
      onRerun: () => {},
      onRerunVariant: () => {},
    }),
  );
  assert.doesNotMatch(noRecipe, /再来 N 组/);
  assert.doesNotMatch(noRecipe, /微调变体/);
});

test("影片／音频／图三张卡：「存图库」接了回调就不再 disabled，回调缺席仍 disabled", () => {
  // 解禁后「存图库」的可点性由回调决定，绝不伪造 handler（同族契约）。
  // 真 SSR 渲染取按钮开标签查 disabled，不做源码字串探针。
  const videoWired = renderToStaticMarkup(
    createElement(AgentVideoCard, { item: videoItem, onSaveToLibrary: () => {} }),
  );
  assert.doesNotMatch(buttonTag(videoWired, "存图库"), / disabled=""/, "接了回调的影片卡存图库必须可点");
  const videoUnwired = renderToStaticMarkup(createElement(AgentVideoCard, { item: videoItem }));
  assert.match(buttonTag(videoUnwired, "存图库"), / disabled=""/, "回调缺席的影片卡存图库仍 disabled");

  const audioWired = renderToStaticMarkup(
    createElement(AgentAudioCard, { item: audioItem, onSaveToLibrary: () => {} }),
  );
  assert.doesNotMatch(buttonTag(audioWired, "存图库"), / disabled=""/, "接了回调的音频卡存图库必须可点");
  const audioUnwired = renderToStaticMarkup(createElement(AgentAudioCard, { item: audioItem }));
  assert.match(buttonTag(audioUnwired, "存图库"), / disabled=""/, "回调缺席的音频卡存图库仍 disabled");

  const imageWired = renderToStaticMarkup(
    createElement(AgentImageCard, { item: imageItem, onSaveToLibrary: () => {} }),
  );
  assert.doesNotMatch(buttonTag(imageWired, "存图库"), / disabled=""/, "接线后图片卡存图库可点（既有契约不变）");
});

test("影片卡：「再来 N 组」用组数选单、「微调」是独立钮；回调缺席 = disabled", () => {
  const wired = renderToStaticMarkup(
    createElement(AgentVideoCard, { item: videoItem, onRerun: () => {}, onVariant: () => {} }),
  );
  assert.match(wired, /再来 N 组/);
  assert.match(wired, /微调/);
  const menuTag = buttonTag(wired, "再来 N 组");
  assert.match(menuTag, /aria-haspopup="menu"/, "组数选单带选单语义");
  assert.doesNotMatch(menuTag, / disabled=""/);
  assert.doesNotMatch(buttonTag(wired, "微调"), / disabled=""/);
  // 选单未展开时不渲染组数档位（SSR＝未展开）。
  assert.doesNotMatch(wired, /再来 3 组/);

  const unwired = renderToStaticMarkup(createElement(AgentVideoCard, { item: videoItem }));
  assert.match(buttonTag(unwired, "再来 N 组"), / disabled=""/);
  assert.match(buttonTag(unwired, "微调"), / disabled=""/);
});

test("音频卡：「再来 N 组」选单、「微调」独立钮；回调缺席 = disabled", () => {
  const wired = renderToStaticMarkup(
    createElement(AgentAudioCard, { item: audioItem, onRerun: () => {}, onVariant: () => {} }),
  );
  assert.match(wired, /再来 N 组/);
  assert.match(wired, /微调/);
  assert.doesNotMatch(buttonTag(wired, "再来 N 组"), / disabled=""/);
  assert.doesNotMatch(buttonTag(wired, "微调"), / disabled=""/);

  const unwired = renderToStaticMarkup(createElement(AgentAudioCard, { item: audioItem }));
  assert.match(buttonTag(unwired, "再来 N 组"), / disabled=""/);
  assert.match(buttonTag(unwired, "微调"), / disabled=""/);
});

/**
 * 2026-10-03 五钮契约整改（暴君逐钮点名）：
 * 存图库要有显式回应、改图＝加附件不送 prompt、放大＝全屏查看、下载＝真下载、分享＝复制连结。
 */
test("图卡：放大改走卡片内全屏查看器，onUpscale 语义已撤除", () => {
  // onUpscale prop 与 AI 放大语义整组不存在（连同 surface / transcript 的接线）。
  assert.doesNotMatch(imageCardSrc, /onUpscale/);
  assert.doesNotMatch(surfaceSrc, /onUpscale/);
  assert.doesNotMatch(transcriptSrc, /onUpscale/);
  // 放大＝setViewerOpen(true)，图标用既有家族的 Expand（不自绘、非 Maximize2 的「修改放大」语义）。
  assert.match(imageCardSrc, /setViewerOpen\(true\)/);
  assert.match(imageCardSrc, /\bExpand\b/);
  const markup = renderToStaticMarkup(createElement(AgentImageCard, { item: imageItem }));
  // 放大钮可点（未损坏），且真的渲染 lucide Expand 图标（不是 Maximize2）。
  assert.doesNotMatch(buttonTag(markup, "放大"), / disabled=""/);
  assert.match(markup, /lucide-expand/);
});

test("图卡：分享卡不再 import/渲染 ShareDialog，改复制连结", () => {
  assert.doesNotMatch(imageCardSrc, /ShareDialog/);
  // 分享流程：补写历史 entry → createShareLink → clipboard.writeText。
  assert.match(imageCardSrc, /saveAgentMediaToHistory\(entry\)/);
  assert.match(imageCardSrc, /createShareLink\(entry, \{ resultIndex: firstShareableIndex\(entry\) \}\)/);
  assert.match(imageCardSrc, /navigator\.clipboard\.writeText\(result\.url\)/);
  // 成功＝「已复制」1.6s、未登入＝「请先登录」2s、其它失败＝「失败」。
  assert.match(imageCardSrc, /已复制/);
  assert.match(imageCardSrc, /请先登录/);
  assert.match(imageCardSrc, /1500|1600/);
});

test("图卡：改图＝抓回位元组加进附件，不送任何 prompt", () => {
  // 卡片本身不再有 send、不再拼「在第 N 张图的基础上继续改图」。
  assert.doesNotMatch(surfaceSrc, /在第 \$\{item\.seq\} 张图的基础上继续改图/);
  assert.doesNotMatch(surfaceSrc, /把第 \$\{item\.seq\} 张图放大/);
  // surface 的 onEdit 走同源媒体下载 + attachFilesRef（既有附件入口），成功回 true。
  assert.match(surfaceSrc, /const onEdit = useCallback\(async \(item: AgentImageItem\): Promise<boolean>/);
  assert.match(surfaceSrc, /\/api\/media-download\?url=\$\{encodeURIComponent\(item\.url\)\}/);
  assert.match(surfaceSrc, /attachFilesRef\.current/);
  assert.match(surfaceSrc, /new File\(\[blob\], `agent-image-\$\{item\.seq\}\.\$\{ext\}`/);
  // 卡片三态：idle／loading 转圈／失败短暂 2s。
  assert.match(imageCardSrc, /setEditState\("loading"\)/);
  assert.match(imageCardSrc, /editState === "failed" \? "失败" : "改图"/);
});

test("三张卡：存图库三态（存图库／已存／未存入）＋下载失败短暂「失败」", () => {
  for (const [name, src] of [
    ["图", imageCardSrc],
    ["影片", videoCardSrc],
    ["音频", audioCardSrc],
  ] as const) {
    assert.match(src, /saveState === "saved" \? "已存" : saveState === "failed" \? "未存入" : "存图库"/, `${name}卡存图库三态文案`);
    assert.match(src, /downState === "failed" \? "失败" : "下载"/, `${name}卡下载失败态`);
    // 成功＝已存定案（本次会话持续）。
    assert.match(src, /setSaveState\("saved"\)/, `${name}卡成功定案已存`);
    // 失败 2s 后回空闲。
    assert.match(src, /2000/, `${name}卡失败 2s 收回`);
  }
});

test("下载：surface 走同源 /api/media-download，不再 window.open 附件连结", () => {
  assert.match(surfaceSrc, /\/api\/media-download\?url=\$\{encodeURIComponent\(url\)\}/);
  assert.match(surfaceSrc, /async function triggerDownload\(url: string, filename: string\): Promise<boolean>/);
  // 暴君点名的病征：失败 fallback 开附件连结——必须绝迹。
  assert.doesNotMatch(surfaceSrc, /window\.open\(/);
  // 三种媒体共用同一条 triggerDownload。
  assert.match(surfaceSrc, /triggerDownload\(item\.url, `agent-\$\{Date\.now\(\)\}\.png`\)/);
  assert.match(surfaceSrc, /triggerDownload\(item\.url, `agent-\$\{Date\.now\(\)\}\.mp4`\)/);
  assert.match(surfaceSrc, /triggerDownload\(item\.url, `agent-\$\{Date\.now\(\)\}\.\$\{ext\}`\)/);
});

test("存图库：surface 契约回 boolean，去重命中与成功都回 true", () => {
  assert.match(surfaceSrc, /const onSaveToLibrary = useCallback\(async \(item: AgentChatLibraryItem\): Promise<boolean>/);
  assert.match(surfaceSrc, /if \(savedIds\.has\(item\.id\)\) return true;/);
  // 去重命中。
  assert.match(surfaceSrc, /setSavedIds\(\(prev\) => new Set\(\[\.\.\.prev, item\.id\]\)\);\s*return true;/);
  // HTTP 失败回 false（不再静默吞掉）。
  assert.match(surfaceSrc, /if \(!res\.ok\) return false;/);
});

test("attachFilesRef 管线：Surface 宣告 ref、Panel 透传、Composer 有 prop", () => {
  assert.match(surfaceSrc, /const attachFilesRef = useRef<\(\(files: File\[\]\) => void\) \| null>\(null\)/);
  assert.match(surfaceSrc, /attachFilesRef=\{attachFilesRef\}/);
  assert.match(panelSrc, /attachFilesRef\?: MutableRefObject<\(\(files: File\[\]\) => void\) \| null>/);
  assert.match(panelSrc, /attachFilesRef=\{attachFilesRef\}/);
});

