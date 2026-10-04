// 助理消息的 Markdown 解析层（纯函数，可测）。
//
// 罪状 3（暴君人肉评测）：模型输出的 Markdown 表格/粗体/列表/代码块此前按
// 纯文本原样糊在气泡里。这里用 marked 的 lexer（v18，仓库唯一 markdown 依赖）
// 把文本解析成结构化 token 树，交给 AgentMarkdown 组件渲染成 React 元素——
// 不走 marked 的 HTML 字符串输出 + dangerouslySetInnerHTML：模型/用户输入
// 里的任何原始 HTML 在这里被直接丢弃，XSS 面为零。
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
 *   - `image.tinchak0207.xyz/v1/images/<id>/result`：预设回 JSON、且须 bearer 金钥
 *     （app/api/v1/images/[id]/result/route.ts:29-45），<img> 送不出 Authorization。
 */
// 参考图目录：三个写入点落盘前全过 validateImageBuffer，只存图片
// （biz-image-references.ts:90、app/api/generation-jobs/route.ts:147、
//  generation-core/artifact-service.ts:482）。
const PLATFORM_IMAGE_URL =
  /^https?:\/\/store\.tinchak0207\.xyz\/image-data\/files\/generation\/references\/[A-Za-z0-9._-]+$/i;
// 音乐生成器交付目录：music-tools.ts 上传，mime→ext 全为 audio/*（agent-output-cards.ts:225）。
const PLATFORM_AUDIO_MUSIC_URL =
  /^https?:\/\/store\.tinchak0207\.xyz\/image-data\/files\/uploads\/music-gen-[A-Za-z0-9._-]+$/i;
// 网关 TTS 公网面：constants-gateway.ts:193 TTS_PUBLIC_BASE，路径即音频。
const PLATFORM_AUDIO_TTS_URL =
  /^https?:\/\/store\.tinchak0207\.xyz\/agent\/v1\/audio\/[A-Za-z0-9._-]+$/i;

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
      return [{ type: "code", lang: (t as Tokens.Code).lang, text: (t as Tokens.Code).text }];
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

/** markdown 文本 → 结构化块序列。解析失败（理论不会）退回单段纯文本，不吞内容。 */
export function parseAgentMarkdown(text: string): MdBlock[] {
  try {
    const blocks: MdBlock[] = [];
    for (const t of lexer(text, { gfm: true, breaks: true })) {
      blocks.push(...blockFromToken(t));
    }
    return blocks;
  } catch {
    return [{ type: "p", children: [{ k: "text", text }] }];
  }
}
