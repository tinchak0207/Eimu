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
  | { k: "br" };

export type MdBlock =
  | { type: "p"; children: MdInline[] }
  | { type: "h"; level: number; children: MdInline[] }
  | { type: "code"; lang?: string; text: string }
  | { type: "quote"; blocks: MdBlock[] }
  | { type: "list"; ordered: boolean; items: MdInline[][] }
  | { type: "table"; head: MdInline[][]; rows: MdInline[][][] };

/**
 * 判断一个 URL 是否指向图片：平台生成的图（pixai / Vercel Blob / 任意直链）
 * 以扩展名判定。命中即由渲染层画成缩略图卡，而不是一串裸 URL 文本。
 */
export function isImageUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  return /\.(png|jpe?g|webp|gif)(\?\S*)?$/i.test(url.trim());
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
