<!-- source: Eimu 内部实测（2026-09-11，VPS /opt/flowmusic2api 上游 genz27/FlowMusic2API MIT；2026-10-03 复测歌词逐字保留）｜license: first-party internal（自有实测数据，非第三方转载）｜ingested: 2026-09-11｜re-measured: 2026-10-03 | 下游 Expert must-load，覆盖 DATA_GOOGLE 在本通路的适用性 -->
---
file_id: DATA_FLOWMUSIC
version: "1.0"
layer: data
valid_as_of: "2026-10-03"
expires: "Reverse-engineered wrapper (FlowMusic2API) over a closed hosted agent (flowmusic.app). Either can change prompt handling without notice — re-measure before trusting this file after 2026-12"
scope: flowmusic2api · lyria_3.5_via_flowmusic · prompt_control_effectiveness · lyrics_handling · wire_transformations
key_concepts: [flowmusic2api, flowmusic_app, producer_standard, sound_prompt, lyrics_verbatim, instrumental_marker, bpm_control, timestamp_control, comma_style, wire_mangling, two_clips_takes]
depends_on: [CORE_00_ENTRY, CORE_01_STYLE, CORE_02_LYRICS]
used_by: [CORE_00_ENTRY, CORE_01_STYLE, CORE_02_LYRICS, CORE_03_DIAGNOSE]
rag_priority: critical
authority: "ON THE FLOWMUSIC2API PATH THIS FILE OVERRIDES DATA_GOOGLE (timestamp/structure claims do not transfer)"
updated: "2026-10-03"
---

# 🟣 EIMU — FLOWMUSIC2API PATH DATA
# File: DATA_FLOWMUSIC · measured 2026-09-11

> ⚠️ **Expiry notice.** Every "实测" line below comes from **3 generations × 2 clips**
> on one account, one day. It is a snapshot of a reverse-engineered wrapper
> (`genz27/FlowMusic2API`, MIT) sitting on a **closed conversational agent**
> (flowmusic.app) that also rewrites prompts server-side. Treat n=3 as
> directional evidence, not a specification. Re-measure if the path misbehaves.

> ↩️ **2026-10-03 re-measure.** One **full tagged-lyric** call (489 chars) confirmed
> §2 ②/⑥: the lyric came back **near-verbatim (489→487, all tags kept)** and the
> single call yielded a 181 s full-length double take. The n=3 *seed-expansion*
> rows below stay as measured on 2026-09-11.

> 🔴 **Scope rule.** The production music path (VPS `FLOWMUSIC2API_URL`, model
> `lyria`) is **not** the Gemini API surface. Timed structural control
> (`[0:00 - 0:10]`) documented in DATA_GOOGLE describes the Gemini
> `lyria-3-pro-preview` interaction API. **It does not transfer here** (see §2).
> Read DATA_GOOGLE for genre/mood/vocabulary craft; read this file for what the
> production path actually honours.

> 🏷️ **Evidence tags used in this file — never mix them:**
> `[实测]` observed in a real response body or measured audio ·
> `[读码]` deterministic code fact read in the upstream source ·
> `[推论]` my inference from the two above · `[未验]` not established.

═══════════════════════════════════════════════════════════════════
§1. WHAT THE PATH IS (and is not)
═══════════════════════════════════════════════════════════════════

<rag_zone id="path_identity">

  Client we send to   POST {FLOWMUSIC2API_URL}/v1/chat/completions (OpenAI-compatible)
  Wrapper             genz27/FlowMusic2API (Go, MIT) — container `flowmusic2api`
  Wrapped product     flowmusic.app (Google Flow Music / ex-Producer AI)
  Model id `lyria`    upstream model_name=`producer:standard`, mode=`standard`,
                      client_context.selected_model=`Lyria 3.5`,
                      ghostwriter_version=`standard`                              [读码]
  Model id `lyria-fast`
                      **identical spec to `lyria`** (same model_name/mode/selected
                      model). Different id only — there is no fast/short mode.   [读码]
  `lyria-pro`         selected_model=`Lyria 3 Pro`, ghostwriter_version=`pro`    [读码]

  Upstream call shape `POST {FLOWMUSIC_BASE_URL}/__api/conversation` with
                      body `{parts:[{content:"直接生成"+<our content>,
                      part_kind:"user-prompt"}], client_context:{...}, mode, model}`.
                      → flowmusic.app's **conversation agent** decides to call tool
                      `audio__create_song(title, sound_prompt, lyrics)`; the wrapper
                      polls the clips and returns them.                          [读码]

  ⇒ Consequence (this is the whole story): we are **talking to an agent, not to a
    TTS/Lyria request body**. Controls only survive if the agent chooses to carry
    them into `sound_prompt` / `lyrics`. There is **no timestamp field, no BPM
    field, no instrumental flag, no separate lyrics field** anywhere on the wire. [读码]

  ⇒ There is **no short / preview / 30s mode**. `duration_hint=clip30` on our side
    maps to `lyria-fast`, which is byte-identical upstream.                        [读码]

  Response surface we can read back (our observability, per clip):
    `clips[]` → `id, title, duration_seconds, format(m4a), audio_url, wav_url,
    image_url, lyrics, lyrics_id, sound_prompt, operation_type`                    [实测]

  ⚠️ `clips[].sound_prompt` is **the style string the agent actually handed to the
    song tool** — the single most useful diagnostic on this path. Read it before
    blaming the audio.

═══════════════════════════════════════════════════════════════════
§2. CONTROL EFFECTIVENESS TABLE (production path)
═══════════════════════════════════════════════════════════════════

<rag_zone id="control_table">

| # | Control | Verdict on this path | Evidence |
|---|---|---|---|
| ① | Six-layer comma style line (genre-first) | **WORKS** — clauses are honoured and come back as a normalised comma list | `[实测]` in: `cinematic orchestral, tense and driving, strings and taiko drums, … , 60 BPM, key of D minor, …` → `sound_prompt`: `cinematic orchestral, tense and driving strings, taiko drums, key of D minor, sparse low drone intro, main ostinato theme, 60 bpm` |
| ② | `[Verse]` / `[Chorus]` section tags | **WORKS; the lyric is controllable when you supply the full tagged block** — tags are adopted and re-emitted verbatim | `[实测 2026-09-11]` a **4-line seed** keeps all 4 lines in both clips *plus* new `[Intro] [Verse 1] [Verse 2] [Bridge] [Outro]` (the agent expands a *seed*; the two clips' extra lines differ). `[实测 2026-10-03]` a **full** 8-section tagged lyric (489 chars) returned **489→487 chars, zero expansion, all tags preserved** — supply the whole lyric and it is what gets sung |
| ③ | `[0:00 - 0:10]` timestamps | **DOES NOT WORK (do not rely on it)** — time codes vanish before the song tool; length is not constrained | `[实测]` timestamps in prompt → `sound_prompt` contains no time code, only the prose (`sparse low drone intro, main ostinato theme`); track came back **177.4 s / 176.0 s** although the prompt described only 0:00–0:40. `[读码]` no timestamp field exists upstream + the wrapper replaces `:` with a space on this branch |
| ④ | `Instrumental only, no vocals.` | **WORKS** — becomes an explicit marker, no vocals written | `[实测]` lyrics returned as exactly `[Instrumental]` (14 chars) on both clips; audio 177 s |
| ⑤ | Explicit BPM (e.g. `60 BPM`) | **WORKS** — survives verbatim into the song tool, and the rendered tempo matches | `[实测]` `60 BPM`→`sound_prompt "...60 bpm"` / `160 BPM`→`"...160 bpm"`; onset-envelope comb analysis (90 s, high-passed, local ffmpeg+stdlib) gave the 60 BPM harmonic family for the 60 BPM clip and the 160 BPM family for the 160 BPM clip (§4) |
| ⑤b | Explicit key (e.g. `key of D minor`) | **SURVIVES** (echoed into `sound_prompt`) | `[实测]` `key of D minor` / `key of G major` both echoed verbatim. **Whether the audio is truly in that key is `[未验]`** — no pitch analysis was run |
| ⑤c | Tempo *word* vs number | `[未验]` — only numeric BPM was tested | — |
| ⑥ | Lyrics embedded in `content` | **DELIVERED verbatim when the full tagged lyric is supplied** (a short *seed* still gets expanded) | `[实测]` see ②; the rendition text is on `clips[].lyrics`; a 4-line seed → ~162 s with extra sections, a full tagged lyric → 181 s, near-verbatim |
| ⑦ | Long style prompt (>220 chars) | **TRUNCATED unless a lyrics marker is present** | `[读码]` cap = 220 runes; cap = 3000 runes when the text contains `歌词`/`lyrics` or a section tag. (These are the **FlowMusic wire caps**; YuE2's separate style-column cap is 600 runes — see the SKILL YuE2 section, not this file.) |
| ⑧ | Punctuation as a delimiter | **UNSAFE** — on the no-lyrics branch `, . ; : ( )` are replaced by spaces | `[读码]` `strings.NewReplacer(","," ","."," ",":"," ", …)`; corroborated (not proven) by ③ |
| ⑨ | Image-to-music / reference audio | `[未验]` — never attempted, no evidence either way | — |

  One-line summary: **① ② ④ ⑤ work, ③ is dead on this path, ⑥ is verbatim if
  you supply the full tagged lyric (a short seed still gets expanded).**

═══════════════════════════════════════════════════════════════════
§3. WIRE TRANSFORMATIONS (what happens to your prompt before it is sent)
═══════════════════════════════════════════════════════════════════

<rag_zone id="wire_transforms">

  All steps `[读码]` (deterministic, read in the wrapper source) — reproduced here
  because they explain the measured behaviour in §2.

  1. Only the **last user message** is used; `system`/`developer` messages are
     dropped. `<tools>`/`<tool_call>` blocks are stripped; the text is capped at
     4000 runes.                                                        [读码]
  2. `歌词`/`lyrics` anywhere in the text, **or** any of
     `[verse] [chorus] [bridge] [intro] [outro] [pre-chorus] [主歌] [副歌]
     [导歌] [桥段] [前奏] [尾奏]` switches the path to **layout-preserving**.   [读码]
  3. **Layout-preserving branch** (lyrics marker present): newlines preserved,
     each line whitespace-collapsed, commas/colons kept, cap 3000 runes.        [读码]
  4. **Flat branch** (no lyrics marker): the whole text becomes **one line**,
     then `，, ；; 。. ：: 、（）()` are replaced by spaces, and words are rewritten:
     `歌曲→音乐`, `song→music`, `cover/image/poster/图片/图像/封面` **deleted**,
     `一首/歌名/作词/API` deleted. Cap 220 runes.                                [读码]
  5. Either way the wrapper **prepends `直接生成`** (and appends `音乐` when no
     music keyword is found).                                                    [读码]

  ⇒ Practical reading: **write the style line as plain prose clauses**; do not
    count on punctuation or brackets to be meaningful, keep the no-lyrics style
    prompt **under ~220 characters**, and if you need the layout to survive
    (multi-line lyric block) make sure the text itself contains the word `歌词`
    or a section tag.

═══════════════════════════════════════════════════════════════════
§4. MEASUREMENT RECORD (2026-09-11, n=3 prompts × 2 clips)
═══════════════════════════════════════════════════════════════════

<rag_zone id="measurement_record">

  Path: VPS `127.0.0.1:8000/v1/chat/completions`, `model=lyria`, `stream=false`,
  account credits 10575, all three returned `HTTP 200` in 33.4 s / 35.8 s / 40.1 s.
  Every prompt returned **2 clips** with distinct `clip_id`s — two takes of the
  same request; on a short seed their added lines differ, on a full tagged lyric
  the lyrics are identical (2026-10-03).

  Run 1 — `60 BPM` + `[0:00 - 0:10]`/`[0:10 - 0:40]` timestamps, instrumental:
    sent    `cinematic orchestral, tense and driving, strings and taiko drums,
             instrumental only no vocals, 60 BPM, key of D minor,
             [0:00 - 0:10] sparse low drone intro, [0:10 - 0:40] main ostinato theme`
    got     titles `Cinematic Tension` / `Shadows in D Minor`; `sound_prompt`
            `cinematic orchestral, tense and driving strings, taiko drums, key of
             D minor, sparse low drone intro, main ostinato theme, 60 bpm`;
            `lyrics` `[Instrumental]`; durations **177.35 s / 176.01 s**.

  Run 2 — same text, `160 BPM`:
    got     titles `Tense Horizon` / `Driving Ostinato`; identical `sound_prompt`
            except `160 bpm`; `lyrics` `[Instrumental]`;
            durations **181.98 s / 180.53 s**.

  Run 3 — song with `[Verse]`/`[Chorus]` lyrics (4 lines) + `90 BPM, key of G major`:
    got     `sound_prompt` `indie folk, warm and nostalgic, acoustic guitar and
            brushed drums, male tenor vocal, key of G major, 90 bpm` (full style
            line survived); both clips titled `Take Me Back to the River`;
            `lyrics` 1105 / 1156 chars, durations **162.44 s / 162.10 s**.

  Tempo check `[实测]` (local: ffmpeg decode → mono 22050 Hz → high-pass 2 kHz →
  onset envelope aucorrelation with harmonic comb scoring, first 90 s):
    60 BPM clip  → top peak **60.0 BPM** (family 90.0 / 120.0 / 180.1 = 1.5×/2×/3×)
    160 BPM clip → peaks **80.0 (=160/2, octave ambiguity) and 160.2 BPM**, plus
                   53.3 (=160/3) and 106.6 (=2×160/3) — all in the 160 family
  Caveat: crude first-party estimator (no librosa/aubio on either host). It
  separates a 60-family from a 160-family periodicity, which is what the claim
  needs; it is **not** a certified tempo measurement.

  Corroborating side-facts `[实测]`:
    · `usage` is always `{0,0,0}` — no token accounting on this path.
    · Instrumental requests are *not* "no lyrics context": the agent writes the
      literal string `[Instrumental]` into the lyrics field.
    · The wrapper keeps its own `request_logs` row per generation; the prompt
      stored there is the **pre-transformation** one, so logs cannot be used to
      inspect what the agent received.

═══════════════════════════════════════════════════════════════════
§5. HOW TO USE THIS IN THE RECIPE LIBRARY
═══════════════════════════════════════════════════════════════════

<rag_zone id="recipe_rules">

  KEEP from the Lyria-oriented teaching (still valid here):
    · Genre-first comma style line, 2–3 hero instruments, mood ≤2 words.
    · Numeric BPM and explicit key — both reach the song tool and the tempo at
      least is audible.
    · Writing lyrics as clearly delimited sections. The tag vocabulary is
      understood and re-emitted; supply the **full** tagged block to get it
      near-verbatim.

  SUSPEND on this path (mark as “此通路无效” wherever the recipes teach them):
    · **Timed structure `[0:00 - 0:10] …`** — no time-code control exists between
      here and the song tool, and it did not constrain length.
    · **“A short lyric seed is sung exactly as written.”** A seed is expanded
      and the two clips may differ; a **full tagged lyric block** is instead
      near-verbatim (2026-10-03: 489→487, all tags kept). Read
      `clips[].lyrics` back before claiming what was delivered.
    · Anything that depends on a **short/preview render** (no such mode upstream).

  OPERATIONAL CHECKLIST (per request, cheap):
    1. Read `clips[].sound_prompt` — if the style clause you care about is missing
       there, the render did not see it; fix the prompt, do not blame the model.
    2. Read `clips[].lyrics` — that is the rendition's text, not your input.
    3. The 2 clips are two takes of one request; on a full tagged lyric the lyrics match, on a short seed the added lines differ — pick by ear.
    4. Keep the no-lyrics style prompt under ~220 characters.

═══════════════════════════════════════════════════════════════════
§6. NOT VERIFIED — DO NOT ASSUME
═══════════════════════════════════════════════════════════════════

<rag_zone id="unverified">

  `[未验]` and therefore unclaimed by this file:
    · Whether the returned key signature actually matches `key of D minor/G major`
      (no pitch/chroma analysis was run).
    · Whether the `160 BPM` peak is the metric level or a double-time feel —
      the estimator cannot resolve metric ambiguity.
    · Anything about image-to-music, reference audio, extend, stems, or the
      `lyria-pro` / ghostwriter `pro` route (never exercised).
    · Behaviour above ~3000 runes, or with `stream=true`.
    · Whether the same controls behave differently on a different upstream
      wrapper or a direct Gemini Lyria call (the Gemini surface is a different
      code path — see DATA_GOOGLE).
    · Stability over time: the wrapper is reverse-engineered and the agent is
      hosted. n=3 on one day is not a trend.

</rag_zone>
