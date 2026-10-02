import test from "node:test";
import assert from "node:assert/strict";
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
