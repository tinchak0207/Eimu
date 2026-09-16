// 配音音色庫測試（刀 3）：
//   - normalizeVoiceEntry 白名單清洗（voiceCode/voiceName 硬條件、標籤去重截斷、數值越界回預設）
//   - 種子完整性（≥60 筆、voice_code 唯一、四維標籤逐字保留）
//   - 資產包 kind "voice" 往返（voiceEntryToAssetPackItem → normalizeAssetPack 不丟欄）
//   - 角色卡綁定與 TTS 參數落定（resolveTtsVoice 優先序 / ttsVoiceRequestParams 支援旗標）
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ITEMS_PER_PACK, normalizeAssetPack } from "./asset-pack-store";
import type { CharacterCard } from "./character-cards";
import {
  ALL_VOICE_ENTRIES,
  GATEWAY_TTS_MODEL,
  GATEWAY_VERIFIED_VOICE_PRESETS,
  GATEWAY_VERIFIED_VOICES,
  VOICE_LIBRARY_SEED,
  VOICE_LIBRARY_SOURCE,
  VOICE_LIBRARY_PACK_ID,
  listPlayableVoiceEntries,
  listVoiceEntries,
  normalizeVoiceEntry,
  resolveTtsVoice,
  ttsVoiceRequestParams,
  voiceCodeFromCards,
  voiceEntriesFromPack,
  voiceEntryByCode,
  voiceEntryToAssetPackItem,
  voiceLibraryPackPayload,
} from "./voice-library";

const FIRST = VOICE_LIBRARY_SEED[0];

function card(partial: Partial<CharacterCard> & { id: string }): CharacterCard {
  return {
    name: partial.id,
    kind: "character",
    prompt: "",
    references: [],
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    ...partial,
  };
}

// ── 清洗白名單 ───────────────────────────────────────────────

test("normalizeVoiceEntry：voiceCode / voiceName 任一缺失即拒絕", () => {
  assert.equal(normalizeVoiceEntry(null), null);
  assert.equal(normalizeVoiceEntry({}), null);
  assert.equal(normalizeVoiceEntry({ voiceCode: "zh_female_vv_uranus_bigtts" }), null);
  assert.equal(normalizeVoiceEntry({ voiceName: "Vivi 2.0" }), null);
  assert.equal(normalizeVoiceEntry({ voiceCode: "   ", voiceName: "x" }), null);
  assert.ok(normalizeVoiceEntry({ voiceCode: "a", voiceName: "b" }));
});

test("normalizeVoiceEntry：標籤去重 / 截斷 8 個 × 32 字；非字串元素丟棄", () => {
  const entry = normalizeVoiceEntry({
    voiceCode: "c1",
    voiceName: "n1",
    characterTypes: ["少女", " 少女 ", "御姐", 42, "", ...Array.from({ length: 20 }, (_, i) => `t${i}`)],
    toneTags: ["x".repeat(50)],
  });
  assert.ok(entry);
  assert.equal(entry.characterTypes.length, 8);
  assert.deepEqual(entry.characterTypes.slice(0, 2), ["少女", "御姐"]);
  assert.equal(entry.toneTags[0].length, 32);
  assert.deepEqual(entry.voiceStyles, []);
});

test("normalizeVoiceEntry：數值越界回預設（不夾取，不偽裝支援）", () => {
  const entry = normalizeVoiceEntry({
    voiceCode: "c1",
    voiceName: "n1",
    defaultSpeed: 3.7,
    defaultPitch: -20,
    sampleRate: 999_999,
    sortOrder: -5,
    gender: "robot",
    audioFormat: "flac",
  });
  assert.ok(entry);
  assert.equal(entry.defaultSpeed, 1.0);
  assert.equal(entry.defaultPitch, 0.0);
  assert.equal(entry.sampleRate, 0);
  assert.equal(entry.sortOrder, 0);
  assert.equal(entry.gender, "neutral");
  assert.equal(entry.audioFormat, "mp3");
});

test("normalizeVoiceEntry：supports* 只認 boolean true（字串 \"1\" 不收）", () => {
  const entry = normalizeVoiceEntry({
    voiceCode: "c1",
    voiceName: "n1",
    supportsEmotion: "1" as unknown as boolean,
    supportsSpeed: true,
  });
  assert.ok(entry);
  assert.equal(entry.supportsEmotion, false);
  assert.equal(entry.supportsSpeed, true);
});

// ── 種子完整性 ───────────────────────────────────────────────

test("種子：種子筆數與溯源常量一致（AID 原文 63 筆）", () => {
  assert.ok(VOICE_LIBRARY_SEED.length >= 60, `種子只有 ${VOICE_LIBRARY_SEED.length} 筆`);
  assert.equal(VOICE_LIBRARY_SEED.length, VOICE_LIBRARY_SOURCE.totalEntries);
});

test("種子：voice_code 唯一", () => {
  const codes = VOICE_LIBRARY_SEED.map((entry) => entry.voiceCode);
  assert.equal(new Set(codes).size, codes.length);
});

test("種子：每筆都過清洗（無壞資料）", () => {
  for (const entry of VOICE_LIBRARY_SEED) {
    assert.ok(normalizeVoiceEntry(entry), `壞條目：${entry?.voiceCode}`);
  }
});

test("種子：首筆四維標籤與試聽文案逐字保留（AID 原文對照）", () => {
  assert.equal(FIRST.voiceCode, "zh_female_vv_uranus_bigtts");
  assert.equal(FIRST.voiceName, "Vivi 2.0");
  assert.deepEqual(FIRST.characterTypes, ["少女"]);
  assert.deepEqual(FIRST.voiceStyles, ["对话", "角色配音", "多语种"]);
  assert.deepEqual(FIRST.toneTags, ["甜美", "温柔"]);
  assert.deepEqual(FIRST.emotionTags, ["ASMR"]);
  assert.equal(FIRST.sampleText, "你好呀，很高兴认识你~");
  assert.equal(FIRST.sampleUrl, "/aid/voice/sample/2026/05/17/5e4fb1b33f494a9d8dfdd86dd07abbd8.mp3");
  assert.equal(FIRST.language, "zh-CN");
  assert.equal(FIRST.gender, "female");
  assert.equal(FIRST.ageRange, "young");
  assert.equal(FIRST.supportsEmotion, true);
  assert.equal(FIRST.defaultSpeed, 1.0);
  assert.equal(FIRST.sampleRate, 24000);
});

test("查詢：voiceEntryByCode 命中/未命中（未命中回 null，不假裝命中）", () => {
  assert.equal(voiceEntryByCode(FIRST.voiceCode)?.voiceName, FIRST.voiceName);
  assert.equal(voiceEntryByCode("not-a-real-voice"), null);
  assert.equal(voiceEntryByCode(undefined), null);
});

test("listVoiceEntries：sort_order 由大到小且筆數 = 全庫", () => {
  const listed = listVoiceEntries();
  assert.equal(listed.length, ALL_VOICE_ENTRIES.length);
  for (let i = 1; i < listed.length; i += 1) {
    assert.ok(listed[i - 1].sortOrder >= listed[i].sortOrder);
  }
  // 實測可播集排在最前（能力事實優先於策展元資料）
  assert.equal(listed[0].playable, true);
});

// ── 資產包 kind "voice" ─────────────────────────────────────

test("資產包：voiceEntryToAssetPackItem → normalizeAssetPack 保留全部音色欄位", () => {
  const pack = normalizeAssetPack(voiceLibraryPackPayload());
  assert.ok(pack);
  assert.equal(pack.id, VOICE_LIBRARY_PACK_ID);
  // 資產包 item 上限 50 < 全庫 71（63 AID + 8 實測）：payload 誠實截斷（不虛報條數）
  assert.equal(pack.items.length, Math.min(ALL_VOICE_ENTRIES.length, MAX_ITEMS_PER_PACK));
  assert.ok(pack.note?.includes("未入包"), "截斷時必須在 note 誠實標明");
  const item = pack.items.find((candidate) => candidate.voiceCode === FIRST.voiceCode);
  assert.ok(item, "首筆音色應在資產包內");
  assert.equal(item.kind, "voice");
  assert.equal(item.voiceName, "Vivi 2.0");
  assert.deepEqual(item.voiceTags, {
    characterTypes: ["少女"],
    voiceStyles: ["对话", "角色配音", "多语种"],
    toneTags: ["甜美", "温柔"],
    emotionTags: ["ASMR"],
  });
  assert.equal(item.sampleText, "你好呀，很高兴认识你~");
  assert.equal(item.sourceSampleUrl, FIRST.sampleUrl);
});

test("資產包：voice item 缺 voiceCode 即被丟（無編碼的音色不可用於 TTS）", () => {
  const pack = normalizeAssetPack({
    id: "p1",
    title: "t",
    items: [{ kind: "voice", title: "壞音色" }, { kind: "voice", title: "好音色", voiceCode: "c1" }],
  });
  assert.ok(pack);
  assert.equal(pack.items.length, 1);
  assert.equal(pack.items[0].voiceCode, "c1");
});

test("資產包：voiceEntriesFromPack 只認 kind voice 並以庫內條目為準", () => {
  const pack = normalizeAssetPack(voiceLibraryPackPayload());
  assert.ok(pack);
  const entries = voiceEntriesFromPack(pack);
  assert.equal(entries.length, pack.items.length);
  assert.equal(entries[0].voiceCode, listVoiceEntries()[0].voiceCode);
  // 庫外自建音色：以 item 自身欄位承接
  const custom = voiceEntriesFromPack({ items: [{ kind: "voice", title: "自建", voiceCode: "custom-1", sampleText: "hi" }] });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].voiceCode, "custom-1");
  assert.equal(custom[0].sampleText, "hi");
  assert.deepEqual(voiceEntriesFromPack(null), []);
});

// ── 角色綁定與 TTS 參數落定 ─────────────────────────────────

test("voiceCodeFromCards：只認角色卡、按 id 升序取第一張", () => {
  const cards = [
    card({ id: "card-b", voiceCode: "voice-b" }),
    card({ id: "card-a", voiceCode: "voice-a" }),
    card({ id: "card-c", kind: "style", voiceCode: "voice-c" }),
  ];
  assert.equal(voiceCodeFromCards(cards), "voice-a");
  assert.equal(voiceCodeFromCards([card({ id: "x" })]), null);
  assert.equal(voiceCodeFromCards([card({ id: "x", voiceCode: "  " })]), null);
  assert.equal(voiceCodeFromCards(null), null);
});

test("resolveTtsVoice：顯式 > 角色卡 > default；source 誠實標記", () => {
  const explicit = resolveTtsVoice({ voiceCode: FIRST.voiceCode });
  assert.deepEqual(
    { code: explicit.voiceCode, source: explicit.source, known: explicit.entry !== null },
    { code: FIRST.voiceCode, source: "library", known: true },
  );
  const unknown = resolveTtsVoice({ voiceCode: "unknown-code" });
  assert.equal(unknown.source, "explicit");
  assert.equal(unknown.entry, null);

  const fromCard = resolveTtsVoice({ cards: [card({ id: "card-a", voiceCode: FIRST.voiceCode })] });
  assert.equal(fromCard.source, "library");
  assert.equal(fromCard.voiceCode, FIRST.voiceCode);

  const fallback = resolveTtsVoice();
  assert.deepEqual(fallback, { voiceCode: "default", entry: null, source: "fallback" });
});

test("清理：normalizeVoiceEntry 永不產生 playable（可播性不可由 payload 宣稱）", () => {
  const forged = normalizeVoiceEntry({
    voiceCode: "zh_female_vv_uranus_bigtts",
    voiceName: "偽造可播",
    playable: true,
    playableEvidence: "假的",
  });
  assert.ok(forged);
  assert.equal(forged.playable, undefined);
  assert.equal(forged.playableEvidence, undefined);
});

test("實測可播集：≥5 條（可試聽門檻）且全帶 playable + 證據", () => {
  const playable = listPlayableVoiceEntries();
  assert.ok(playable.length >= 5, `可試聽音色只有 ${playable.length} 條，未達 ≥5 門檻`);
  assert.equal(playable.length, GATEWAY_VERIFIED_VOICES.length);
  for (const entry of playable) {
    assert.equal(entry.playable, true);
    assert.ok(entry.playableEvidence && entry.playableEvidence.length > 20, `缺證據：${entry.voiceCode}`);
    assert.ok(entry.voiceCode.startsWith(`${GATEWAY_TTS_MODEL}:`), "可播 code 必須是 <model>:<preset>（無冒號會被網關改寫）");
  }
  assert.deepEqual(
    playable.map((entry) => entry.voiceCode),
    [...GATEWAY_VERIFIED_VOICE_PRESETS].map((preset) => `${GATEWAY_TTS_MODEL}:${preset}`),
  );
});

test("全庫：AID 種子 ∪ 實測可播集，voiceCode 仍唯一", () => {
  assert.equal(ALL_VOICE_ENTRIES.length, VOICE_LIBRARY_SEED.length + GATEWAY_VERIFIED_VOICES.length);
  const codes = ALL_VOICE_ENTRIES.map((entry) => entry.voiceCode);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(listVoiceEntries().length, ALL_VOICE_ENTRIES.length);
});

test("資產包：可試聽集必須全部入包（能力事實不可被策展元資料擠掉）", () => {
  const pack = normalizeAssetPack(voiceLibraryPackPayload());
  assert.ok(pack);
  const codesInPack = new Set(pack.items.map((item) => item.voiceCode));
  for (const entry of GATEWAY_VERIFIED_VOICES) {
    assert.ok(codesInPack.has(entry.voiceCode), `可試聽音色被截斷：${entry.voiceCode}`);
  }
  // 讀回時 playable 由庫內事實還原（外部 payload 無法偽造）
  const entries = voiceEntriesFromPack(pack);
  assert.equal(entries.filter((entry) => entry.playable === true).length, GATEWAY_VERIFIED_VOICES.length);
});

test("資產包：讀回的庫外自建音色 playable 為 undefined（不冒充可播）", () => {
  const custom = voiceEntriesFromPack({ items: [{ kind: "voice", title: "自建", voiceCode: "custom-1" }] });
  assert.equal(custom.length, 1);
  assert.equal(custom[0].playable, undefined);
});

test("ttsVoiceRequestParams：不支援的維度不落參數；顯式覆寫優先", () => {
  const resolution = resolveTtsVoice({ voiceCode: FIRST.voiceCode });
  const defaults = ttsVoiceRequestParams({ resolution });
  assert.deepEqual(defaults, { voice: FIRST.voiceCode });

  const explicit = ttsVoiceRequestParams({ resolution, speed: 1.5, pitch: 3 });
  assert.deepEqual(explicit, { voice: FIRST.voiceCode, speed: 1.5, pitch: 3 });

  const outOfRange = ttsVoiceRequestParams({ resolution, speed: 99 });
  assert.equal(outOfRange.speed, undefined, "越界顯式值不得被夾取後冒充支援");
});

test("ttsVoiceRequestParams：庫條目只在 support 旗標為真時帶默認語速/音調；emotion 永不自動套", () => {
  const unsupported = normalizeVoiceEntry({
    voiceCode: "no-support",
    voiceName: "不支援",
    defaultSpeed: 0.5,
    supportsSpeed: false,
    defaultPitch: -6,
    supportsPitch: false,
    supportsEmotion: false,
    emotionTags: ["ASMR"],
  });
  assert.ok(unsupported);
  const params = ttsVoiceRequestParams({ resolution: { voiceCode: "no-support", entry: unsupported, source: "library" } });
  assert.deepEqual(params, { voice: "no-support" });

  const supported = normalizeVoiceEntry({
    voiceCode: "with-support",
    voiceName: "支援",
    defaultSpeed: 0.5,
    supportsSpeed: true,
    defaultPitch: -6,
    supportsPitch: true,
    supportsEmotion: true,
    emotionTags: ["ASMR"],
  });
  assert.ok(supported);
  const params2 = ttsVoiceRequestParams({ resolution: { voiceCode: "with-support", entry: supported, source: "library" } });
  assert.deepEqual(params2, { voice: "with-support", speed: 0.5, pitch: -6 }, "emotion 未顯式要求不得自動帶入");
  const params3 = ttsVoiceRequestParams({
    resolution: { voiceCode: "with-support", entry: supported, source: "library" },
    emotion: "ASMR",
  });
  assert.equal(params3.emotion, "ASMR", "顯式 emotion 才轉發");
});

// ── TTS adapter 分支（tts-upstream.ts）：voice_code 落 artifact metadata ──

function ttsSupplier(overrides: Record<string, unknown> = {}) {
  return {
    id: "env:tts-local",
    label: "tts-local",
    adapterType: "tts_speech",
    supplyTier: "first_party",
    failureDomain: "localhost",
    baseUrl: "http://127.0.0.1:8893/openai/v1",
    credentialRef: "TTS_UNUSED_KEY",
    configuration: {},
    priority: 1,
    concurrencyLimit: 1,
    qualityScore: 1,
    unitCost: 0,
    healthStatus: "healthy",
    healthScore: 1,
    latencyEwmaMs: null,
    supplierModelId: "tts-1",
    capabilityId: 1,
    capabilityConcurrencyLimit: 1,
    contractVersion: 1,
    capabilityHealthStatus: "healthy",
    account: {
      id: "env:tts-local:default",
      supplierId: "env:tts-local",
      label: "tts-local default",
      credentialRef: "TTS_UNUSED_KEY",
      concurrencyLimit: 1,
      healthStatus: "healthy",
      tokenSource: "not_applicable",
      credentialExpiresAt: null,
      refreshStatus: "healthy",
      successRate5m: 1,
      healthObservedAt: new Date(),
      configuration: {},
    },
    ...overrides,
  } as never;
}

function ttsInput(workflow: Record<string, unknown>) {
  return {
    jobId: "job-tts",
    attemptId: "attempt-tts",
    modelId: "tts-1",
    supplierModelId: "tts-1",
    prompt: "你好呀，很高兴认识你~",
    kind: "tts" as const,
    size: null,
    ratio: null,
    resolution: null,
    quality: null,
    workflow,
  } as never;
}

function mockTtsFetch(status: number, bytes: Buffer, bodyText?: string) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (fetchInput: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(fetchInput),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: status < 400,
      status,
      headers: new Headers(),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      text: async () => bodyText ?? "",
    } as unknown as Response;
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const MP3_BYTES = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(200, 7)]);

test("tts adapter：庫內音色 → voice_code 落 artifact metadata（可查證）", async () => {
  const mock = mockTtsFetch(200, MP3_BYTES);
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    const output = await generateWithTtsSpeech(
      ttsSupplier(),
      ttsInput({ voice: FIRST.voiceCode, cards: [] }),
    );
    assert.equal(mock.calls.length, 1);
    assert.ok(mock.calls[0].url.endsWith("/audio/speech"), "應打 /audio/speech");
    assert.equal(mock.calls[0].body.voice, FIRST.voiceCode);
    assert.equal(mock.calls[0].body.input, "你好呀，很高兴认识你~");
    assert.equal(mock.calls[0].body.response_format, "mp3");
    assert.equal(output.artifactMetadata?.voice_code, FIRST.voiceCode);
    assert.equal(output.artifactMetadata?.voice_source, "library");
    assert.equal(output.artifactMetadata?.voice_library_known, true);
    assert.equal(output.base64, MP3_BYTES.toString("base64"));
  } finally {
    mock.restore();
  }
});

test("tts adapter：誠實性——AID bigtts code（無冒號）標 collapsed，不冒充音色生效", async () => {
  const mock = mockTtsFetch(200, MP3_BYTES);
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    const output = await generateWithTtsSpeech(ttsSupplier(), ttsInput({ voice: FIRST.voiceCode }));
    // 上游照樣 200（網關會改寫成 model:alex），但 metadata 必須顯式記下不生效
    assert.equal(output.httpStatus, 200);
    assert.equal(output.artifactMetadata?.voice_effective, "collapsed");
    assert.equal(output.artifactMetadata?.voice_library_known, true);
  } finally {
    mock.restore();
  }
});

test("tts adapter：實測可播音色標 verified；庫外帶冒號 code 標 unknown", async () => {
  const mock = mockTtsFetch(200, MP3_BYTES);
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    const playable = GATEWAY_VERIFIED_VOICES[0];
    const verified = await generateWithTtsSpeech(ttsSupplier(), ttsInput({ voice: playable.voiceCode }));
    assert.equal(verified.artifactMetadata?.voice_effective, "verified");
    assert.equal(verified.artifactMetadata?.voice_source, "library");
    const unknown = await generateWithTtsSpeech(ttsSupplier(), ttsInput({ voice: "OtherModel:someone" }));
    assert.equal(unknown.artifactMetadata?.voice_effective, "unknown");
    assert.equal(unknown.artifactMetadata?.voice_library_known, false);
  } finally {
    mock.restore();
  }
});

test("tts adapter：角色卡綁定音色（無顯式 voice 時生效）", async () => {
  const mock = mockTtsFetch(200, MP3_BYTES);
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    const output = await generateWithTtsSpeech(
      ttsSupplier(),
      ttsInput({ cards: [card({ id: "card-a", voiceCode: FIRST.voiceCode })] }),
    );
    assert.equal(mock.calls[0].body.voice, FIRST.voiceCode);
    assert.equal(output.artifactMetadata?.voice_code, FIRST.voiceCode);
    assert.equal(output.artifactMetadata?.voice_source, "library");
  } finally {
    mock.restore();
  }
});

test("tts adapter：無音色 → default 且 metadata 誠實標 fallback（不假裝命中庫）", async () => {
  const mock = mockTtsFetch(200, MP3_BYTES);
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    const output = await generateWithTtsSpeech(ttsSupplier(), ttsInput({}));
    assert.equal(mock.calls[0].body.voice, "default");
    assert.equal(output.artifactMetadata?.voice_code, "default");
    assert.equal(output.artifactMetadata?.voice_source, "fallback");
    assert.equal(output.artifactMetadata?.voice_library_known, false);
  } finally {
    mock.restore();
  }
});

test("tts adapter：pitch/emotion 未在 configuration.ttsParams 宣告時不轉發", async () => {
  const mock = mockTtsFetch(200, MP3_BYTES);
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    await generateWithTtsSpeech(
      ttsSupplier(),
      ttsInput({ voice: FIRST.voiceCode, speed: 1.5, pitch: 4, emotion: "ASMR" }),
    );
    assert.equal(mock.calls[0].body.speed, 1.5, "speed 是 OpenAI 兼容標準欄，直接轉發");
    assert.equal(mock.calls[0].body.pitch, undefined);
    assert.equal(mock.calls[0].body.emotion, undefined);
  } finally {
    mock.restore();
  }
});

test("tts adapter：上游 400 且訊息涉及 voice → user_input（不誤判 model_unsupported 停用供應商）", async () => {
  const mock = mockTtsFetch(400, Buffer.alloc(0), JSON.stringify({ error: { message: "invalid voice: xxx" } }));
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    await assert.rejects(
      generateWithTtsSpeech(ttsSupplier(), ttsInput({ voice: "bogus-voice" })),
      (error: Error & { explicitClass?: string }) => {
        assert.match(error.message, /invalid voice/);
        assert.equal(error.explicitClass, "user_input");
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});

test("tts adapter：上游回空 body → empty_result", async () => {
  const mock = mockTtsFetch(200, Buffer.alloc(0));
  try {
    const { generateWithTtsSpeech } = await import("./generation-core/tts-upstream");
    await assert.rejects(
      generateWithTtsSpeech(ttsSupplier(), ttsInput({ voice: FIRST.voiceCode })),
      (error: Error & { explicitClass?: string }) => {
        assert.equal(error.explicitClass, "empty_result");
        return true;
      },
    );
  } finally {
    mock.restore();
  }
});
