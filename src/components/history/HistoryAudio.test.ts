// 音乐历史记录（2026-10-03）：行为断言，不靠源码字串断言。
// 惯例（同 canvas/lens-picker.test.ts）：node:test + SSR 真渲染；tsconfig 排除
// *.test.tsx，故用 .ts + createElement，并在 SSR 前补全局 React 桩（classic runtime）。
import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as unknown as Record<string, unknown>).React ??= React;

import { HistoryCard } from "./HistoryCard";
import { HistoryFilterBar } from "./HistoryFilterBar";
import { HistoryGrid } from "./HistoryGrid";
import { DELIVERABLE_KIND_IDS, deliverableKindLabel, filterableDeliverableKinds } from "@/lib/deliverable-kind";
import { inferEntryKind, hasImage, NON_DELIVERABLE_ENTRY_KINDS } from "@/lib/history-types";
import { ENTRY_KIND_VALUES, parseEntryKind } from "./history-kind-filter";
import type { HistoryEntry } from "@/lib/history-types";

const AUDIO_URL = "https://cdn.test/track.mp3";
const IMAGE_URL = "https://cdn.test/pic.png";

/** 从 SSR 结果里摘出所有 chip（aria-pressed）的文字，去标签后返回。 */
function chipLabels(html: string): string[] {
  return [...html.matchAll(/<button[^>]*aria-pressed[^>]*>(.*?)<\/button>/g)].map((match) =>
    match[1].replace(/<[^>]*>/g, "").trim(),
  );
}

function audioEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "audio-1",
    prompt: "夏日微风",
    generatedAt: Date.now(),
    source: "server",
    entryKind: "audio",
    results: [
      { provider: "music", modelId: "lyria", image: null, imageUrl: null, audioUrl: AUDIO_URL, mediaType: "audio" },
    ],
    ...overrides,
  };
}

function imageEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "image-1",
    prompt: "一只戴帽子的猫",
    generatedAt: Date.now(),
    source: "server",
    entryKind: "image",
    results: [{ provider: "image_tinchak", modelId: "gpt-image-2", image: null, imageUrl: IMAGE_URL }],
    ...overrides,
  };
}

test("inferEntryKind 认音频：显式 entryKind 与仅有 audioUrl 的记录都判为 audio", () => {
  assert.equal(inferEntryKind(audioEntry()), "audio");
  // 旧记录没有 entryKind，只有 results[].audioUrl（经 normalize 后可能只有这个字段）
  const legacy: HistoryEntry = {
    id: "legacy",
    prompt: "",
    generatedAt: 1,
    source: "server",
    results: [{ provider: "music", modelId: "lyria", image: null, imageUrl: null, audioUrl: AUDIO_URL }],
  };
  assert.equal(inferEntryKind(legacy), "audio");
  // 音频与 VIDEO 同级计入「有产物」，否则「有图」筛选会把音乐记录整批漏掉
  assert.equal(hasImage(audioEntry()), true);
});

test("历史筛选栏的种类 chip 由注册表推导（文字集合与数量都不手写）", () => {
  const html = renderToStaticMarkup(
    createElement(HistoryFilterBar, {
      query: {},
      facets: null,
      onExportCsv: () => {},
      onExportJson: () => {},
      onChange: () => {},
    }),
  );

  // 期待值由注册表推导：可筛选交付物的 label ＋ 非交付种类（无注册表文案，沿用站内「工作流」字样）。
  const expectedLabels = [
    ...filterableDeliverableKinds().map((kind) => kind.label),
    "工作流",
  ];
  const labels = chipLabels(html);
  const kindChipLabels = labels.filter((label) => expectedLabels.includes(label));

  // ① chip 文字集合＝注册表 label 集合＋「工作流」
  assert.deepEqual(
    [...kindChipLabels].sort(),
    [...expectedLabels].sort(),
    "种类 chip 文字集合与注册表推导不一致",
  );

  // ② chip 数量＝可筛选交付物数＋非交付种类数
  assert.equal(
    kindChipLabels.length,
    filterableDeliverableKinds().length + NON_DELIVERABLE_ENTRY_KINDS.length,
    "种类 chip 数量与注册表推导不一致",
  );

  // 顺序＝注册表宣告序（image→video→audio）＋非交付种类（工作流在最后）。
  const positions = expectedLabels.map((label) => html.indexOf(label));
  assert.ok(positions.every((index) => index >= 0), "类型 chip 未全部渲染");
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    "类型档位顺序应为注册表宣告序",
  );
});

test("ENTRY_KIND_VALUES／parseEntryKind 由注册表推导（URL 白名单不硬编）", () => {
  const derived = [...DELIVERABLE_KIND_IDS, ...NON_DELIVERABLE_ENTRY_KINDS];
  assert.deepEqual([...ENTRY_KIND_VALUES], derived, "URL 种类白名单与注册表推导不一致");

  for (const value of derived) {
    assert.equal(parseEntryKind(value), value, `${value} 应被 URL 白名单放行`);
  }
  assert.equal(parseEntryKind("hologram"), "all");
  assert.equal(parseEntryKind(""), "all");
  assert.equal(parseEntryKind(null), "all");
});

test("音频记录的历史卡真的渲染可播放 <audio>（src 指向 audioUrl），不是「没有留存图片」死卡", () => {
  const html = renderToStaticMarkup(
    createElement(HistoryCard, {
      entry: audioEntry(),
      selectionMode: false,
      selected: false,
      onOpen: () => {},
      onToggleSelect: () => {},
      onToggleStar: () => {},
      onDownload: () => {},
      onDelete: () => {},
    }),
  );

  assert.ok(html.includes("<audio"), "音频卡没有渲染 <audio> 播放器");
  assert.match(html, new RegExp(`src="${AUDIO_URL.replace(/\./g, "\\.")}"`), "播放器 src 未指向 audioUrl");
  // ④ 音乐徽章文字＝注册表 label（値来自 deliverable-kind，不是卡内手写）
  const audioLabel = deliverableKindLabel("audio");
  assert.equal(audioLabel, "音乐", "注册表里音频的 UI 文案应为站内既有的「音乐」");
  assert.ok(html.includes(audioLabel), "音频卡没有按注册表 label 渲染音乐徽章");
  assert.ok(!html.includes("没有留存图片"), "音频卡落回了「没有留存图片」占位");
});

test("HistoryGrid 的 kind 档位真的按音频过滤（不是只渲染同名 chip）", () => {
  const common = {
    selectionMode: false,
    selectedIds: new Set<string>(),
    loadingMore: false,
    hasMore: false,
    onLoadMore: () => {},
    onOpen: () => {},
    onToggleSelect: () => {},
    onToggleStar: () => {},
    onDownload: () => {},
    onDelete: () => {},
  };
  const entries = [audioEntry(), imageEntry()];

  const audioOnly = renderToStaticMarkup(createElement(HistoryGrid, { entries, entryKindFilter: "audio", ...common }));
  assert.ok(audioOnly.includes(AUDIO_URL), "选「音乐」档时应渲染音频卡");
  assert.ok(!audioOnly.includes(IMAGE_URL), "选「音乐」档时不应渲染图片卡");

  const imageOnly = renderToStaticMarkup(createElement(HistoryGrid, { entries, entryKindFilter: "image", ...common }));
  assert.ok(imageOnly.includes(IMAGE_URL), "选「图片」档时应渲染图片卡");
  assert.ok(!imageOnly.includes(AUDIO_URL), "选「图片」档时不应渲染音频卡");
});
