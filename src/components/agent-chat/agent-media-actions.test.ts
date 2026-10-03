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

test("圖卡：配方可重跑時才渲染「再来 N 组／微调变体」，回調缺席 = disabled", () => {
  // 回調給足：文字真的上屏，按鈕可點（無 disabled 屬性）。
  const wired = renderToStaticMarkup(
    createElement(AgentImageCard, { item: imageItem, onRerun: () => {}, onRerunVariant: () => {} }),
  );
  assert.match(wired, /再来 N 组/);
  assert.match(wired, /微调变体/);
  assert.doesNotMatch(buttonTag(wired, "再来 N 组"), / disabled=""/);
  assert.doesNotMatch(buttonTag(wired, "微调变体"), / disabled=""/);

  // 回調缺席：按鈕仍在（可重跑）但 disabled，不偽造行為。
  const unwired = renderToStaticMarkup(createElement(AgentImageCard, { item: imageItem }));
  assert.match(buttonTag(unwired, "再来 N 组"), / disabled=""/);
  assert.match(buttonTag(unwired, "微调变体"), / disabled=""/);
});

test("圖卡：配方推不出可計價模型時，兩顆鈕整組不渲染", () => {
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

test("影片／音頻／圖三張卡：「存图库」接了回調就不再 disabled，回調缺席仍 disabled", () => {
  // 解禁后「存图库」的可点性由回調決定，絕不偽造 handler（同族契約）。
  // 真 SSR 渲染取按鈕開標籤查 disabled，不做源碼字串探針。
  const videoWired = renderToStaticMarkup(
    createElement(AgentVideoCard, { item: videoItem, onSaveToLibrary: () => {} }),
  );
  assert.doesNotMatch(buttonTag(videoWired, "存图库"), / disabled=""/, "接了回調的影片卡存图库必須可點");
  const videoUnwired = renderToStaticMarkup(createElement(AgentVideoCard, { item: videoItem }));
  assert.match(buttonTag(videoUnwired, "存图库"), / disabled=""/, "回調缺席的影片卡存图库仍 disabled");

  const audioWired = renderToStaticMarkup(
    createElement(AgentAudioCard, { item: audioItem, onSaveToLibrary: () => {} }),
  );
  assert.doesNotMatch(buttonTag(audioWired, "存图库"), / disabled=""/, "接了回調的音頻卡存图库必須可點");
  const audioUnwired = renderToStaticMarkup(createElement(AgentAudioCard, { item: audioItem }));
  assert.match(buttonTag(audioUnwired, "存图库"), / disabled=""/, "回調缺席的音頻卡存图库仍 disabled");

  const imageWired = renderToStaticMarkup(
    createElement(AgentImageCard, { item: imageItem, onSaveToLibrary: () => {} }),
  );
  assert.doesNotMatch(buttonTag(imageWired, "存图库"), / disabled=""/, "接線後圖片卡存图库可點（既有契約不變）");
});

test("影片卡：「再来 N 组」用組數選單、「微调」是獨立鈕；回調缺席 = disabled", () => {
  const wired = renderToStaticMarkup(
    createElement(AgentVideoCard, { item: videoItem, onRerun: () => {}, onVariant: () => {} }),
  );
  assert.match(wired, /再来 N 组/);
  assert.match(wired, /微调/);
  const menuTag = buttonTag(wired, "再来 N 组");
  assert.match(menuTag, /aria-haspopup="menu"/, "組數選單帶選單語義");
  assert.doesNotMatch(menuTag, / disabled=""/);
  assert.doesNotMatch(buttonTag(wired, "微调"), / disabled=""/);
  // 選單未展開時不渲染組數檔位（SSR＝未展開）。
  assert.doesNotMatch(wired, /再来 3 组/);

  const unwired = renderToStaticMarkup(createElement(AgentVideoCard, { item: videoItem }));
  assert.match(buttonTag(unwired, "再来 N 组"), / disabled=""/);
  assert.match(buttonTag(unwired, "微调"), / disabled=""/);
});

test("音頻卡：「再来 N 组」選單、「微调」獨立鈕；回調缺席 = disabled", () => {
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
 * 2026-10-03 五鈕契約整改（暴君逐鈕點名）：
 * 存图库要有顯式回應、改图＝加附件不送 prompt、放大＝全屏查看、下載＝真下載、分享＝複製連結。
 */
test("圖卡：放大改走卡片內全屏查看器，onUpscale 語義已撤除", () => {
  // onUpscale prop 與 AI 放大語義整組不存在（連同 surface / transcript 的接線）。
  assert.doesNotMatch(imageCardSrc, /onUpscale/);
  assert.doesNotMatch(surfaceSrc, /onUpscale/);
  assert.doesNotMatch(transcriptSrc, /onUpscale/);
  // 放大＝setViewerOpen(true)，圖標用既有家族的 Expand（不自繪、非 Maximize2 的「修改放大」語義）。
  assert.match(imageCardSrc, /setViewerOpen\(true\)/);
  assert.match(imageCardSrc, /\bExpand\b/);
  const markup = renderToStaticMarkup(createElement(AgentImageCard, { item: imageItem }));
  // 放大鈕可點（未損壞），且真的渲染 lucide Expand 圖標（不是 Maximize2）。
  assert.doesNotMatch(buttonTag(markup, "放大"), / disabled=""/);
  assert.match(markup, /lucide-expand/);
});

test("圖卡：分享卡不再 import/渲染 ShareDialog，改複製連結", () => {
  assert.doesNotMatch(imageCardSrc, /ShareDialog/);
  // 分享流程：補寫歷史 entry → createShareLink → clipboard.writeText。
  assert.match(imageCardSrc, /saveAgentMediaToHistory\(entry\)/);
  assert.match(imageCardSrc, /createShareLink\(entry, \{ resultIndex: firstShareableIndex\(entry\) \}\)/);
  assert.match(imageCardSrc, /navigator\.clipboard\.writeText\(result\.url\)/);
  // 成功＝「已复制」1.6s、未登入＝「请先登录」2s、其它失敗＝「失败」。
  assert.match(imageCardSrc, /已复制/);
  assert.match(imageCardSrc, /请先登录/);
  assert.match(imageCardSrc, /1500|1600/);
});

test("圖卡：改图＝抓回位元組加進附件，不送任何 prompt", () => {
  // 卡片本身不再有 send、不再拼「在第 N 张图的基础上继续改图」。
  assert.doesNotMatch(surfaceSrc, /在第 \$\{item\.seq\} 张图的基础上继续改图/);
  assert.doesNotMatch(surfaceSrc, /把第 \$\{item\.seq\} 张图放大/);
  // surface 的 onEdit 走同源媒體下載 + attachFilesRef（既有附件入口），成功回 true。
  assert.match(surfaceSrc, /const onEdit = useCallback\(async \(item: AgentImageItem\): Promise<boolean>/);
  assert.match(surfaceSrc, /\/api\/media-download\?url=\$\{encodeURIComponent\(item\.url\)\}/);
  assert.match(surfaceSrc, /attachFilesRef\.current/);
  assert.match(surfaceSrc, /new File\(\[blob\], `agent-image-\$\{item\.seq\}\.\$\{ext\}`/);
  // 卡片三態：idle／loading 轉圈／失敗短暫 2s。
  assert.match(imageCardSrc, /setEditState\("loading"\)/);
  assert.match(imageCardSrc, /editState === "failed" \? "失败" : "改图"/);
});

test("三張卡：存图库三態（存图库／已存／未存入）＋下載失敗短暫「失败」", () => {
  for (const [name, src] of [
    ["圖", imageCardSrc],
    ["影片", videoCardSrc],
    ["音頻", audioCardSrc],
  ] as const) {
    assert.match(src, /saveState === "saved" \? "已存" : saveState === "failed" \? "未存入" : "存图库"/, `${name}卡存图库三態文案`);
    assert.match(src, /downState === "failed" \? "失败" : "下载"/, `${name}卡下載失敗態`);
    // 成功＝已存定案（本次會話持續）。
    assert.match(src, /setSaveState\("saved"\)/, `${name}卡成功定案已存`);
    // 失敗 2s 後回空閒。
    assert.match(src, /2000/, `${name}卡失敗 2s 收回`);
  }
});

test("下載：surface 走同源 /api/media-download，不再 window.open 附件連結", () => {
  assert.match(surfaceSrc, /\/api\/media-download\?url=\$\{encodeURIComponent\(url\)\}/);
  assert.match(surfaceSrc, /async function triggerDownload\(url: string, filename: string\): Promise<boolean>/);
  // 暴君點名的病徵：失敗 fallback 開附件連結——必須絕跡。
  assert.doesNotMatch(surfaceSrc, /window\.open\(/);
  // 三種媒體共用同一條 triggerDownload。
  assert.match(surfaceSrc, /triggerDownload\(item\.url, `agent-\$\{Date\.now\(\)\}\.png`\)/);
  assert.match(surfaceSrc, /triggerDownload\(item\.url, `agent-\$\{Date\.now\(\)\}\.mp4`\)/);
  assert.match(surfaceSrc, /triggerDownload\(item\.url, `agent-\$\{Date\.now\(\)\}\.\$\{ext\}`\)/);
});

test("存图库：surface 契約回 boolean，去重命中與成功都回 true", () => {
  assert.match(surfaceSrc, /const onSaveToLibrary = useCallback\(async \(item: AgentChatLibraryItem\): Promise<boolean>/);
  assert.match(surfaceSrc, /if \(savedIds\.has\(item\.id\)\) return true;/);
  // 去重命中。
  assert.match(surfaceSrc, /setSavedIds\(\(prev\) => new Set\(\[\.\.\.prev, item\.id\]\)\);\s*return true;/);
  // HTTP 失敗回 false（不再靜默吞掉）。
  assert.match(surfaceSrc, /if \(!res\.ok\) return false;/);
});

test("attachFilesRef 管線：Surface 宣告 ref、Panel 透傳、Composer 有 prop", () => {
  assert.match(surfaceSrc, /const attachFilesRef = useRef<\(\(files: File\[\]\) => void\) \| null>\(null\)/);
  assert.match(surfaceSrc, /attachFilesRef=\{attachFilesRef\}/);
  assert.match(panelSrc, /attachFilesRef\?: MutableRefObject<\(\(files: File\[\]\) => void\) \| null>/);
  assert.match(panelSrc, /attachFilesRef=\{attachFilesRef\}/);
});

