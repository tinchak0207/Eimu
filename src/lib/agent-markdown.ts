// 助理消息的 Markdown 解析层（纯函数，可测）。
//
// 罪状 3（项目负责人逐条评测）：模型输出的 Markdown 表格/粗体/列表/代码块此前按
// 纯文本原样糊在气泡里。这里用 marked 的 lexer（v18，仓库唯一 markdown 依赖）
// 把文本解析成结构化 token 树，交给 AgentMarkdown 组件渲染成 React 元素——
// 不走 marked 的 HTML 字符串输出 + dangerouslySetInnerHTML：模型/用户输入
// 里的任何原始 HTML 在这里被直接丢弃，XSS 面为零。
import { OPENUI_ROOT_LINE_RE, OPENUI_STATEMENT_LINE_RE } from "./openui/catalog";
import { lexer, type Token, type Tokens } from "marked";

/** 行内 span。link 指向图片时由渲染层转缩略图（罪状 9）。 */
export type MdInline =
  | { k: "text"; text: string }
  | { k: "strong"; children: MdInline[] }
  | { k: "em"; children: MdInline[] }
  | { k: "del"; children: MdInline[] }
  | { k: "code"; text: string }
  | { k: "link"; href: string; children: MdInline[] }
  | { k: "img"; src: string; alt: string }
  | { k: "video"; src: string }
  | { k: "audio"; src: string }
  | { k: "br" };

export type MdBlock =
  | { type: "p"; children: MdInline[] }
  | { type: "h"; level: number; children: MdInline[] }
  | { type: "code"; lang?: string; text: string }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "table"; head: MdInline[][]; rows: MdInline[][][] };

/**
 * 平台自产媒体路径的补判（2026-10-02）。
 *
 * 三支判定器原本只认副档名。平台交付 URL 产出时多带副档名（见
 * agent-output-cards.ts:221-231 对音频 URL 的实查），但模型回覆里仍会出现
 * **缺副档名**的平台直链，纯扩展名判定会漏判、退化成裸连结。
 *
 * 补判只收「目录语义钉死单一媒体」的形状，且规则一律精确主机＋精确路径前缀。
 * 以下是生产中多种媒体混居的形状，**故意不补判**，维持裸连结——宁可留连结，
 * 也不画无法证实的媒体卡（画错卡比裸连结更伤）：
 *   - `image-data/files/generation/jobs/`：artifact-service.ts:454 同目录落图
 *     （png/webp）与影片（mp4，实例见 eval-director-extreme 成片 URL），无法由路径判型。
 *   - `image-data/files/uploads/media-*`：media-internal-routes.ts:80 同时接受
 *     image/*、video/*、audio/*（实测有 .png、.m4a、.wav、.flac）。
 *   - `image-data/files/agent-batch3/`：实测同目录有 .png（amx-landscape_169-*）
 *     与 .wav（video-evidence-*），且此目录由 agent 临时写入、无稳定命名契约。
 *   - `image.eimu.dev/v1/images/<id>/result`：预设回 JSON、且须 bearer 金钥
 *     （app/api/v1/images/[id]/result/route.ts:29-45），<img> 送不出 Authorization。
 */
// 参考图目录：三个写入点落盘前全过 validateImageBuffer，只存图片
// （biz-image-references.ts:90、app/api/generation-jobs/route.ts:147、
//  generation-core/artifact-service.ts:482）。
const PLATFORM_IMAGE_URL =
  /^https?:\/\/store\.eimu\.xyz\/image-data\/files\/generation\/references\/[A-Za-z0-9._-]+$/i;
// 音乐生成器交付目录：music-tools.ts 上传，mime→ext 全为 audio/*（agent-output-cards.ts:225）。
const PLATFORM_AUDIO_MUSIC_URL =
  /^https?:\/\/store\.eimu\.xyz\/image-data\/files\/uploads\/music-gen-[A-Za-z0-9._-]+$/i;
// 网关 TTS 公网面：constants-gateway.ts:193 TTS_PUBLIC_BASE，路径即音频。
const PLATFORM_AUDIO_TTS_URL =
  /^https?:\/\/store\.eimu\.xyz\/agent\/v1\/audio\/[A-Za-z0-9._-]+$/i;

/**
 * 判断一个 URL 是否指向图片：平台生成的图（pixai / Vercel Blob / 任意直链）
 * 以扩展名判定，另加平台「只存图片」目录的补判（见上方 PLATFORM_*）。命中即由
 * 渲染层画成缩略图卡，而不是一串裸 URL 文本。
 */
export function isImageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(url.trim()) || PLATFORM_IMAGE_URL.test(url.trim());
}

/**
 * 影片直链（mp4/mov/webm/m4v）：命中即由渲染层画成播放器，不留裸 URL。
 * 无「extensionless 且能钉死是影片」的平台形状可补（generation/jobs 图影混居），故不动。
 */
export function isVideoUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.(mp4|mov|webm|m4v)(\?\S*)?$/i.test(url.trim());
}

/** 音频直链（m4a/mp3/wav/aac/ogg/flac/opus）：同上，画成音频播放器，另加平台「只存音频」前缀补判。 */
export function isAudioUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const trimmed = url.trim();
  return (
    /\.(m4a|mp3|wav|aac|ogg|flac|opus)(\?\S*)?$/i.test(trimmed) ||
    PLATFORM_AUDIO_MUSIC_URL.test(trimmed) ||
    PLATFORM_AUDIO_TTS_URL.test(trimmed)
  );
}

function inlineFromTokens(tokens: Token[] | undefined): MdInline[] {
  const out: MdInline[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        // marked 的 text token 可能携带子 inline tokens（转义/软换行等）。
        const tok = t as Tokens.Text;
        if (tok.tokens && tok.tokens.length > 0) out.push(...inlineFromTokens(tok.tokens));
        else out.push({ k: "text", text: tok.text });
        break;
      }
      case "escape":
        out.push({ k: "text", text: (t as Tokens.Escape).text });
        break;
      case "strong":
        out.push({ k: "strong", children: inlineFromTokens((t as Tokens.Strong).tokens) });
        break;
      case "em":
        out.push({ k: "em", children: inlineFromTokens((t as Tokens.Em).tokens) });
        break;
      case "del":
        out.push({ k: "del", children: inlineFromTokens((t as Tokens.Del).tokens) });
        break;
      case "codespan":
        out.push({ k: "code", text: (t as Tokens.Codespan).text });
        break;
      case "link": {
        const tok = t as Tokens.Link;
        // 图片直链的 <a>：整条转缩略图，不留裸 URL 文本。
        if (isImageUrl(tok.href)) {
          out.push({ k: "img", src: tok.href, alt: tok.text });
        } else if (isVideoUrl(tok.href)) {
          out.push({ k: "video", src: tok.href });
        } else if (isAudioUrl(tok.href)) {
          out.push({ k: "audio", src: tok.href });
        } else {
          out.push({ k: "link", href: tok.href, children: inlineFromTokens(tok.tokens) });
        }
        break;
      }
      case "image": {
        const tok = t as Tokens.Image;
        out.push({ k: "img", src: tok.href, alt: tok.text });
        break;
      }
      case "br":
        out.push({ k: "br" });
        break;
      // html token 一律丢弃：模型输出里的原始 HTML 不进 DOM。
      default:
        break;
    }
  }
  return out;
}

/** 列表项展平：嵌套子列表的项并入同级（聊天气泡里层级缩进价值低，展平最稳）。 */
function listItems(listToken: Tokens.List): MdInline[][] {
  const items: MdInline[][] = [];
  for (const item of listToken.items) {
    const spans: MdInline[] = [];
    for (const t of item.tokens) {
      if (t.type === "list") {
        items.push(...listItems(t as Tokens.List));
      } else if (t.type === "text") {
        const tok = t as Tokens.Text;
        if (tok.tokens && tok.tokens.length > 0) {
          spans.push(...inlineFromTokens(tok.tokens));
        } else {
          const leaf: MdInline = { k: "text", text: tok.text };
          spans.push(leaf);
        }
      } else if (t.type === "paragraph") {
        spans.push(...inlineFromTokens((t as Tokens.Paragraph).tokens));
      }
      // checkbox / 其它块级：聊天气泡里不出现，忽略。
    }
    if (spans.length > 0) items.push(spans);
  }
  return items;
}

function blockFromToken(t: Token): MdBlock[] {
  switch (t.type) {
    case "paragraph":
      return [{ type: "p", children: inlineFromTokens((t as Tokens.Paragraph).tokens) }];
    case "heading":
      return [{ type: "h", level: (t as Tokens.Heading).depth, children: inlineFromTokens((t as Tokens.Heading).tokens) }];
    case "code":
    {
      const code = t as Tokens.Code;
      // 未标语言（或泛用语言名）但内容是 openui 程序 → 按裸 DSL 渲染（失败退回普通代码文本）。
      if (!isOpenUILang(code.lang) && GENERIC_CODE_LANGS.has(normalizeCodeLang(code.lang).split(/\s+/)[0]) && looksLikeOpenUIProgram(code.text)) {
        return [{ type: "code", lang: "openui bare", text: code.text }];
      }
      return [{ type: "code", lang: code.lang, text: code.text }];
    }
    case "blockquote": {
      const inner: MdBlock[] = [];
      for (const child of (t as Tokens.Blockquote).tokens ?? []) inner.push(...blockFromToken(child));
      return [{ type: "quote", blocks: inner }];
    }
    case "list":
      return [{ type: "list", ordered: (t as Tokens.List).ordered, items: listItems(t as Tokens.List) }];
    case "table": {
      const tok = t as Tokens.Table;
      return [
        {
          type: "table",
          head: tok.header.map((cell) => inlineFromTokens(cell.tokens)),
          rows: tok.rows.map((row) => row.map((cell) => inlineFromTokens(cell.tokens))),
        },
      ];
    }
    // space / hr / html：不产生可见块。
    default:
      return [];
  }
}

/** 语言名归一：fence info string 的大小写与前后空白都不该影响分派。 */
export function normalizeCodeLang(lang?: string): string {
  return (lang ?? "").trim().toLowerCase();
}

/** 模型常见的 openui 围栏语言名写法（含 openui-lang 等变体）。 */
const OPENUI_LANGS = new Set(["openui", "openui-lang", "openuilang", "open-ui", "oui"]);
/** 无语言名或泛用语言名的代码块：内容像 openui 程序时也按 openui 渲染。 */
// 模型也会把赋值式 DSL 标成 ini；仅内容满足 OpenUI 程序判据才转交受限解释器。
const GENERIC_CODE_LANGS = new Set(["", "text", "plaintext", "plain", "txt", "dsl", "ui", "ini"]);

/** 是否 OpenUI 栅栏（`OpenUI`、` openui `、`openui title=demo`、`openui-lang` 一律算）。 */
export function isOpenUILang(lang?: string): boolean {
  // info string 的第一个词是语言名，其后是参数（如 `openui title=demo`）。
  // 空串安全："" / 空白都 split 出 ""，不在集合里。
  return OPENUI_LANGS.has(normalizeCodeLang(lang).split(/\s+/)[0]);
}

/**
 * 该 openui 块是否由「裸 DSL 识别」包出来的（info string 带 `bare`）。
 * 这类块解析失败时必须退回成普通可读文本，而不是折叠的「原文」。
 */
export function isBareOpenUIInfo(lang?: string): boolean {
  const words = normalizeCodeLang(lang).split(/\s+/);
  return OPENUI_LANGS.has(words[0]) && words.includes("bare");
}

/** 一段文本整体是否像 openui 程序（首个非空行是 `root = X(`，或 ≥2 条语句且含 Card(）。 */
export function looksLikeOpenUIProgram(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return false;
  if (OPENUI_ROOT_LINE_RE.test(lines[0])) return true;
  const stmts = lines.filter((l) => OPENUI_STATEMENT_LINE_RE.test(l));
  return stmts.length >= 2 && stmts.length >= lines.length * 0.8 && /\bCard\s*\(/i.test(text);
}

/** 一行内括号深度变化（忽略字符串里的括号）。 */
function bracketDelta(line: string): number {
  let d = 0;
  let quote: string | null = null;
  let esc = false;
  for (const ch of line) {
    if (quote) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[" || ch === "{") d += 1;
    else if (ch === ")" || ch === "]" || ch === "}") d -= 1;
  }
  return d;
}

const BARE_ROOT_TAIL_RE = /^\s*root\s*=\s*[A-Za-z_]*\s*$/;
const OPENUI_LABEL_LINE_RE = /^\s*(?:openui|openui-lang)\s*:?\s*$/i;

/**
 * 裸 DSL 识别（2026-10-18）：模型不守约、没套 ```openui 围栏时，把正文里的
 * openui 程序段落包成 ```openui bare 围栏。判据保守：
 *   - 起点必须是 `root = 组件名(` 行（流式时末行仅 `root =` 也算起点，避免先
 *     闪一下纯文本再变成卡片）；
 *   - 向后连续吃「语句行」或括号未闭合的续行；空行只在下一行仍是语句时跨过；
 *   - 有效条件：≥2 条语句、或吃到文末（流式中）、或单行 root 里含 Card(；
 *   - 起点前紧邻的语句行与单独的 `openui` 标签行一并收进来。
 * 围栏内的文本一律不动。误判时由渲染端退回普通文本（见 isBareOpenUIInfo）。
 */
export function fenceBareOpenUI(text: string): string {
  if (!/\broot\s*=/.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (fence) {
      const m = FENCE_CLOSE.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      out.push(line);
      i += 1;
      continue;
    }
    const fo = FENCE_OPEN.exec(line);
    if (fo) {
      fence = { ch: fo[2][0], len: fo[2].length };
      out.push(line);
      i += 1;
      continue;
    }
    const isLast = i === lines.length - 1;
    if (!OPENUI_ROOT_LINE_RE.test(line) && !(isLast && BARE_ROOT_TAIL_RE.test(line))) {
      out.push(line);
      i += 1;
      continue;
    }
    // 起点前紧邻的语句行（含组件调用）与 openui 标签行
    const pre: string[] = [];
    while (out.length && OPENUI_STATEMENT_LINE_RE.test(out[out.length - 1]) && /\(/.test(out[out.length - 1])) {
      pre.unshift(out.pop()!);
    }
    if (out.length && OPENUI_LABEL_LINE_RE.test(out[out.length - 1])) out.pop();
    const block: string[] = [];
    let depth = 0;
    let stmts = 0;
    let j = i;
    while (j < lines.length) {
      const l = lines[j];
      if (depth > 0) {
        block.push(l);
        depth += bracketDelta(l);
        j += 1;
        continue;
      }
      if (j === i || OPENUI_STATEMENT_LINE_RE.test(l)) {
        block.push(l);
        stmts += 1;
        depth = Math.max(0, bracketDelta(l));
        j += 1;
        continue;
      }
      if (!l.trim()) {
        let k = j;
        while (k < lines.length && !lines[k].trim()) k += 1;
        if (k < lines.length && OPENUI_STATEMENT_LINE_RE.test(lines[k])) {
          while (j < k) block.push(lines[j++]);
          continue;
        }
      }
      break;
    }
    const reachedEnd = j >= lines.length;
    const valid = stmts + pre.length >= 2 || reachedEnd || /\bCard\s*\(/.test(line);
    if (!valid) {
      out.push(...pre, line);
      i += 1;
      continue;
    }
    while (block.length && !block[block.length - 1].trim()) block.pop();
    out.push("```openui bare", ...pre, ...block, "```");
    changed = true;
    i = j;
  }
  return changed ? out.join("\n") : text;
}

// CommonMark 围栏：≤3 空格缩进，``` / ~~~ 至少三个。opening 的 info string
// 取第一个词（`openui` 之外可能还带参数，语言名仍要认得出来）。
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 流式收尾保障（2026-10-17）：assistant 文本逐 delta 到达时，一个 OpenUI 栅栏
 * 可能正处于「已开、未闭」状态。marked 本身会把未闭合栅栏吃到文末，但这里按
 * 契约显式补上闭合围栏再交给 lexer——让 `code` token 的边界确定，避免下游
 * （流式渲染器）在「文末是不是还有下文」上做猜测。
 *
 * 纯函数：只扫描围栏状态，只在「文本结束时仍处于 openui 围栏内」时追加
 * 一个换行 + 同字符同长度的闭合围栏。普通代码块、未开栅栏的文本一字不动，
 * 不会凭空吞内容。
 */
function closeUnterminatedOpenUIFence(text: string): string {
  let open: { ch: string; len: number; lang: string } | null = null;
  for (const line of text.split("\n")) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line);
      if (!m) continue;
      const fence = m[2];
      const info = m[3].trim();
      // CommonMark：反引号围栏的 info string 不能再含反引号（否则那是行内代码）。
      if (fence[0] === "`" && info.includes("`")) continue;
      open = { ch: fence[0], len: fence.length, lang: info.split(/\s+/)[0] ?? "" };
    } else {
      const m = FENCE_CLOSE.exec(line);
      if (!m) continue;
      const fence = m[1];
      // 同字符且长度 ≥ opening 才算闭合（`~~~` 不在 ``` 围栏里闭合）。
      if (fence[0] === open.ch && fence.length >= open.len) open = null;
    }
  }
  if (!open || !isOpenUILang(open.lang)) return text;
  // 只在缺行尾换行时补一个：否则会凭空多出一个空行、改变代码原文的尾端。
  const gap = text.endsWith("\n") ? "" : "\n";
  return `${text}${gap}${open.ch.repeat(open.len)}`;
}

/**
 * 兜底（2026-10-18）：openui 围栏里出现「```正文」粘连行时拆成「```」+「正文」。
 * 起因：网关把收尾提示直接拼在模型的闭合围栏后面（```本轮由我直接完成…），
 * CommonMark 不认带文字的闭合行 → 围栏不闭合 → DSL 解析失败、整段裸露。
 * openui 程序行不可能以反引号开头，所以 openui 围栏内的这类行只可能是「闭合 + 粘连正文」。
 * 纯函数：只动 openui 围栏内的粘连行，其它代码块/正文一字不动。
 */
function splitGluedOpenUIFenceClose(text: string): string {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let open: { ch: string; len: number; openui: boolean } | null = null;
  let changed = false;
  for (const line of lines) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line);
      if (m && !(m[2][0] === "`" && m[3].includes("`"))) {
        open = { ch: m[2][0], len: m[2].length, openui: isOpenUILang(m[3].trim().split(/\s+/)[0] ?? "") };
      }
      out.push(line);
      continue;
    }
    const close = FENCE_CLOSE.exec(line);
    if (close) {
      if (close[1][0] === open.ch && close[1].length >= open.len) open = null;
      out.push(line);
      continue;
    }
    if (open.openui) {
      const glued = /^( {0,3})(`{3,}|~{3,})[ \t]*(\S.*)$/.exec(line);
      if (glued && glued[2][0] === open.ch && glued[2].length >= open.len) {
        out.push(`${glued[1]}${glued[2]}`, glued[3]);
        open = null;
        changed = true;
        continue;
      }
    }
    out.push(line);
  }
  return changed ? out.join("\n") : text;
}

/** markdown 文本 → 结构化块序列。解析失败（理论不会）退回单段纯文本，不吞内容。 */
export function parseAgentMarkdown(text: string): MdBlock[] {
  try {
    const blocks: MdBlock[] = [];
    // 预处理：⓪ 拆「```+正文」粘连闭合行；① 裸 DSL 包成 ```openui bare；② 补流式中未闭合的 openui 围栏。其余原样进 lexer。
    for (const t of lexer(closeUnterminatedOpenUIFence(fenceBareOpenUI(splitGluedOpenUIFenceClose(text))), { gfm: true, breaks: true })) {
      blocks.push(...blockFromToken(t));
    }
    return blocks;
  } catch {
    return [{ type: "p", children: [{ k: "text", text }] }];
  }
}
