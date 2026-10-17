/**
 * Eimu 的 OpenUI 组件库（生成式 UI）。
 *
 * 组成方式：直接复用 `@openuidev/react-ui` 的 `openuiChatLibrary` 成品组件，
 * 只做「精选 + 收窄接口」，不重写任何 render / 视觉。
 *
 * 为什么需要收窄 Card / FormControl / Carousel：
 * - chat 库的 Card.children、FormControl.input、Carousel.children 是预先拼好的
 *   union，会把整个 80 组件库都写进 system prompt（含我们未注册的图表、卡片块），
 *   模型照签名产出就会落到「不存在的组件 → 静默丢弃」。
 * - 这里用同一批 renderer 重新声明 schema，只保留 eimuLibrary 实际注册的组件，
 *   不改变任何渲染行为。
 *
 * 硬指标：`generateSystemPrompt({ library: eimuLibrary.toSpec(), promptOptions: eimuPromptOptions })`
 * 必须 <= 14000 字符（全量 chat 库约 53k）。`tools/gen-openui-prompt.mts` 会打印实测值。
 *
 * 注意：本文件会被 Node 脚本（tsx）与客户端组件同时 import，**不要在这里 import CSS**。
 */
import { createElement } from "react";
import {
  createLibrary,
  defineComponent,
  type DefinedComponent,
  type PromptOptions,
} from "@openuidev/react-lang";
import { openuiChatLibrary, openuiChatPromptOptions } from "@openuidev/react-ui";
import { z } from "zod/v4";

import { OPENUI_COMPONENTS } from "./catalog";
import type { ArgOrderMap } from "./repair";

type AnyComponent = DefinedComponent<any>;

const sourceComponents = openuiChatLibrary.components as unknown as Record<string, AnyComponent>;

function pick(name: string): AnyComponent {
  const component = sourceComponents[name];
  if (!component) {
    throw new Error(`[eimu-library] @openuidev/react-ui 缺少组件 "${name}"，检查包版本`);
  }
  return component;
}

export type OpenUIImageItem = { src: string; alt?: string; details?: string };

/**
 * 图片 URL 安全闸（纯函数，供 Image/ImageBlock/ImageGallery 与单测脚本复用）。
 *
 * 只允许 http(s) 公网地址：拒绝 javascript:/data:/file:/blob: 等协议，
 * 拒绝 loopback / 私网 / link-local / 云元数据地址，拒绝带账号密码的 URL，
 * 避免模型把浏览器变成内网探测器。
 */
export function isSafeRemoteImageUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  // 统一规范化：小写、去末尾点、去 IPv6 方括号后再判断。
  let host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return false;

  const isPrivateIPv4 = (a: number, b: number) =>
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10（含阿里元数据 100.100.100.200）
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31);

  /** 只接受规范点分十进制；前导零（八进制歧义）一律拒绝。 */
  const parseDottedIPv4 = (input: string): number[] | null => {
    const parts = input.split(".");
    if (parts.length !== 4) return null;
    if (parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
    if (parts.some((part) => part.length > 1 && part.startsWith("0"))) return null;
    const nums = parts.map(Number);
    return nums.some((n) => n > 255) ? null : nums;
  };

  // ── IPv6 字面量 ──
  if (host.includes(":")) {
    // IPv4-mapped：::ffff:7f00:1 / ::ffff:c0a8:101 / ::ffff:127.0.0.1
    if (host.startsWith("::ffff:")) {
      const rest = host.slice("::ffff:".length);
      let mapped: number[] | null = null;

      if (rest.includes(".")) {
        mapped = parseDottedIPv4(rest);
      } else {
        const groups = rest.split(":");
        if (groups.length === 1 && /^[0-9a-f]{1,8}$/.test(groups[0])) {
          const packed = Number.parseInt(groups[0], 16);
          mapped = [packed >>> 24, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255];
        } else if (groups.length === 2 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
          const packed =
            Number.parseInt(groups[0], 16) * 0x10000 + Number.parseInt(groups[1], 16);
          mapped = [packed >>> 24, (packed >>> 16) & 255, (packed >>> 8) & 255, packed & 255];
        }
      }

      // 解码失败一律拒绝；解码成功则套用 IPv4 私网规则。
      if (!mapped) return false;
      return !isPrivateIPv4(mapped[0], mapped[1]);
    }

    // :: / ::1 / 其余 "::" 压缩形式（含 IPv4-compatible）一律拒绝。
    if (host === "::" || host === "::1") return false;
    if (host.startsWith("::")) return false;

    const firstGroup = host.split(":")[0];
    if (/^[0-9a-f]{1,4}$/.test(firstGroup)) {
      const first = Number.parseInt(firstGroup, 16);
      if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
      if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    }
    return true;
  }

  // ── 数字/十六进制/八进制伪装主机 ──
  if (/^\d+$/.test(host)) return false; // 2130706433
  if (/^0x[0-9a-f]+$/i.test(host)) return false;
  const dotted = parseDottedIPv4(host);
  if (dotted) {
    if (dotted.every((part) => part === 255)) return false; // 255.255.255.255
    return !isPrivateIPv4(dotted[0], dotted[1]);
  }
  // 点分但不是规范 IPv4（前导零、超范围等）
  if (/^\d+(\.\d+){1,3}$/.test(host)) return false;

  // ── 域名 ──
  if (host === "localhost" || host === "ip6-localhost" || host === "metadata.google.internal") {
    return false;
  }

  const BLOCKED_SUFFIXES = [
    ".internal",
    ".local",
    ".localhost",
    ".localdomain",
    ".nip.io",
    ".sslip.io",
    ".xip.io",
    ".my-ip.io",
    ".localtest.me",
    ".lvh.me",
    ".traefik.me",
    ".vcap.me",
  ];
  if (BLOCKED_SUFFIXES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) {
    return false;
  }

  return true;
}

/** ImageGallery 过滤非法项；全部非法时返回空数组（渲染 null）。 */
export function filterSafeImageItems(images: unknown): OpenUIImageItem[] {
  if (!Array.isArray(images)) return [];
  return images.filter((item): item is OpenUIImageItem => {
    if (!item || typeof item !== "object") return false;
    return isSafeRemoteImageUrl((item as { src?: unknown }).src);
  });
}

/** 按行统计 `identifier = Expression` 语句数（允许行首空格/tab/Unicode 空白缩进）。 */
export function countOpenUIStatements(code: string): number {
  // NBSP / 全角空格 / ZWSP / BOM 先归一成普通空格，避免缩进绕过。
  const normalized = code.replace(/[\u00A0\u3000\u200B\uFEFF]/g, " ");
  const matches = normalized.match(/^[ \t]*[A-Za-z_$][\w$]*\s*=/gm);
  return matches?.length ?? 0;
}

/** 组件/函数调用数（`Name(`），用于挡住单条 statement 内联上万个 Tag。 */
export function countComponentCalls(code: string): number {
  const matches = code.match(/[A-Za-z_$][\w$]*\s*\(/g);
  return matches?.length ?? 0;
}

/**
 * 括号最大嵌套深度（忽略字符串内的括号）。
 * Renderer 在 240 层会抛 RangeError（220 层正常），组件层用 >200 预检。
 */
export function maxBracketDepth(code: string): number {
  let depth = 0;
  let max = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "(" || char === "{") {
      depth += 1;
      if (depth > max) max = depth;
    } else if (char === "]" || char === ")" || char === "}") {
      if (depth > 0) depth -= 1;
    }
  }
  return max;
}

/**
 * 引用链最大深度：`a1 = Card([a2]); a2 = Card([a3]); …` 这种 ref 型嵌套每行
 * 括号深度只有 2，括号闸漏检，但 Renderer 递归求值同样会栈溢出。
 * 建 `name → 引用到的 name` 图后 DFS 求最长链；带环时靠 visited 终止。
 */
export function maxReferenceDepth(code: string): number {
  const STATEMENT_RE = /^[ \t]*([A-Za-z_$][\w$]*)\s*=\s*(.*)$/gm;
  const edges = new Map<string, string[]>();
  const declared = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = STATEMENT_RE.exec(code)) !== null) {
    const [, name, expression] = match;
    declared.add(name);
    const refs: string[] = [];
    const IDENT_RE = /[A-Za-z_$][\w$]*/g;
    let ident: RegExpExecArray | null;
    while ((ident = IDENT_RE.exec(expression)) !== null) {
      const token = ident[0];
      // 跳过紧随 `(` 的组件/函数名与 `@` 动作名。
      if (expression[ident.index + token.length] === "(") continue;
      if (ident.index > 0 && expression[ident.index - 1] === "@") continue;
      if (token === name) continue;
      refs.push(token);
    }
    edges.set(name, refs);
  }

  const memo = new Map<string, number>();
  const inProgress = new Set<string>();

  const depthOf = (name: string): number => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    if (inProgress.has(name)) return 0; // 环：不计数但必须终止
    inProgress.add(name);

    let best = 1;
    for (const ref of edges.get(name) ?? []) {
      if (!declared.has(ref)) continue;
      const child = depthOf(ref);
      if (child + 1 > best) best = child + 1;
    }

    inProgress.delete(name);
    memo.set(name, best);
    return best;
  };

  let max = 0;
  for (const name of edges.keys()) {
    const depth = depthOf(name);
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * 统一剥离 Markdown 图片（生成源治理）：
 * - 内联 `![alt](url "title")` / `![alt](<url>)` → alt（空 alt 删除）
 * - 引用式/快捷式 `![alt][ref]` / `![alt][]` / `![alt]` → alt
 * - 原始 HTML `<img ...>` → 删除
 * - 不区分 URL 是否安全：产品上图片只准走 Image / ImageBlock / ImageGallery
 * - 循环到稳定（≤5 轮）处理嵌套 alt
 * - 围栏代码块与行内代码内文本不动
 */
function stripPlainMarkdownImages(chunk: string): string {
  let current = chunk;
  for (let round = 0; round < 5; round += 1) {
    const next = current
      .replace(/<\s*img\b[^>]*>/gi, "")
      // 内联图片（alt 允许嵌套一层方括号，URL 段不含括号），可带 title。
      .replace(
        /!\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\(\s*(?:<[^>]*>|[^()\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g,
        "$1",
      )
      // 引用式/快捷式同理。
      .replace(/!\[((?:[^\[\]]|\[[^\[\]]*\])*)\]\[[^\]]*\]/g, "$1")
      .replace(/!\[((?:[^\[\]]|\[[^\[\]]*\])*)\]/g, "$1");
    if (next === current) break;
    current = next;
  }
  // 兜底：剥完图片语法后若还残留 `](url)`（嵌套 alt 被短路吃掉留下的半截），
  // 把纯 URL 段一并去掉，避免把私网地址当正文留在气泡里。
  return current.replace(/\(\s*(?:<[^>]*>|[^()\s]*http[^()\s]*)\s*\)/gi, "");
}

export function stripMarkdownImages(text: string): string {
  if (!text || (!text.includes("![") && !/<\s*img/i.test(text))) return text;

  let result = "";
  let plainStart = 0;
  let i = 0;

  while (i < text.length) {
    let codeEnd = -1;

    if (text[i] === "`") {
      let run = 0;
      while (text[i + run] === "`") run += 1;
      const marker = "`".repeat(run);
      const end = text.indexOf(marker, i + run);
      if (end === -1) {
        // 未闭合：3+ 个反引号是围栏代码块（到文末）；单个/两个是普通文本，
        // 不能因为一个未闭合反引号就放弃后续清洗。
        codeEnd = run >= 3 ? text.length : -1;
      } else {
        codeEnd = end + run;
      }
    } else if (text[i] === "~" && text.startsWith("~~~", i)) {
      const end = text.indexOf("~~~", i + 3);
      codeEnd = end === -1 ? text.length : end + 3;
    }

    if (codeEnd > i) {
      result += stripPlainMarkdownImages(text.slice(plainStart, i));
      result += text.slice(i, codeEnd);
      plainStart = codeEnd;
      i = codeEnd;
      continue;
    }
    i += 1;
  }

  result += stripPlainMarkdownImages(text.slice(plainStart));
  return result;
}

/** 兼容旧名（行为已升级为「一律剥离」）。 */
export const sanitizeMarkdownImages = stripMarkdownImages;

/**
 * 递归清洗 props 里的字符串；数组/普通对象递归。
 * ElementNode（{type:"element", typeName, props}）**保留结构但清洗其 props**：
 * Steps 这类容器的 renderer 直接读 `item.props.details` 并交给 Markdown 渲染，
 * 若整块跳过就会漏掉 StepsItem 的私网图片。React 元素仍原样返回。
 */
export function deepStrip(value: unknown): unknown {
  if (typeof value === "string") return stripMarkdownImages(value);
  if (Array.isArray(value)) return value.map((item) => deepStrip(item));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  if ("$$typeof" in record) return value; // React element
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) out[key] = deepStrip(item);
  return out;
}

/**
 * 给任意组件统一套上 Markdown 图片剥离（唯一真源，未来新组件自动覆盖）。
 * props schema / description 原样复用，因此 system prompt 的签名逐字不变。
 */
function wrapSanitized(component: AnyComponent): AnyComponent {
  return defineComponent({
    name: component.name,
    props: component.props,
    description: component.description,
    component: (renderProps) =>
      createElement(component.component as any, {
        ...renderProps,
        props: deepStrip(renderProps.props) as any,
      }),
  });
}

/**
 * 精选组件：唯一真源在 `catalog.ts`（网关提示词、修复映射、裸 DSL 识别共用）。
 * 2026-10-18 收窄到 28 个以压缩提示词：Text/BoldText/MarkDownRenderer/
 * InlineHeader/IconText/CodeBlock/MetricIndicatorInline/Label → 由 repair.ts
 * 收成 TextContent；Image → ImageBlock；Carousel 移除。
 */
const SELECTED: readonly string[] = OPENUI_COMPONENTS;

const refOf = (name: string) => pick(name).ref;

/** zod union 需要至少两个元素的元组类型。 */
const unionOf = (schemas: unknown[]) =>
  z.union(schemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);

/**
 * 只有容器型组件能直接作为 Card 的 children；字段/子项（FormControl、
 * SelectItem、Col、Button、OptionCard、StepsItem、Label、Icon）
 * 由各自的父组件消费，不作为顶层块。
 */
const CARD_CHILD_EXCLUDED = new Set([
  "Card",
  "FormControl",
  "Label",
  "Input",
  "TextArea",
  "Select",
  "SelectItem",
  "Slider",
  "CheckBoxGroup",
  "CheckBoxItem",
  "RadioGroup",
  "RadioItem",
  "Button",
  "OptionCard",
  "StepsItem",
  "Col",
  "Icon",
  "IconText",
]);

/** FormControl 可挂的输入控件（chat 库另有 DatePicker / Chips，本库未收录）。 */
const FORM_FIELD_NAMES = [
  "Input",
  "TextArea",
  "Select",
  "Slider",
  "CheckBoxGroup",
  "RadioGroup",
  "OptionCards",
];

/** OptionCard：原 schema 的 topContent 是 Icon | Image，本库不注册 Image，收窄为 Icon。 */
const EimuOptionCard = defineComponent({
  name: "OptionCard",
  props: z.object({
    value: z.string(),
    title: z.string(),
    subtitle: z.string().optional(),
    topContent: (pick("Icon").ref as unknown as z.ZodTypeAny).optional(),
    disabled: z.boolean().optional(),
  }),
  description: pick("OptionCard").description,
  component: pick("OptionCard").component,
});

const EimuOptionCards = defineComponent({
  name: "OptionCards",
  props: z.object({
    ...(pick("OptionCards").props as unknown as { shape: Record<string, z.ZodTypeAny> }).shape,
    items: z.array(EimuOptionCard.ref).optional(),
  }),
  description: pick("OptionCards").description,
  component: pick("OptionCards").component,
});

const EimuFormControl = defineComponent({
  name: "FormControl",
  props: z.object({
    label: z.string(),
    input: unionOf(FORM_FIELD_NAMES.map((n) => (n === "OptionCards" ? EimuOptionCards.ref : refOf(n)))),
    hint: z.string().optional(),
  }),
  description: pick("FormControl").description,
  component: pick("FormControl").component,
});

/**
 * Form 的原 schema 引用的是原始 FormControl，必须一起换成本库的窄接口，
 * 否则 parser 会报 “field expects object but got component FormControl”。
 */
const EimuForm = defineComponent({
  name: "Form",
  props: z.object({
    name: z.string(),
    buttons: pick("Buttons").ref,
    fields: z.array(EimuFormControl.ref).default([]),
  }),
  description: pick("Form").description,
  component: pick("Form").component,
});

/**
 * 图片组件守卫：复用官方 renderer，只拦非法 URL，避免模型用图片槽探测内网
 * （127.* / localhost / 169.254.169.254 / data: / file: 等）。
 */
const EimuImageBlock = defineComponent({
  name: "ImageBlock",
  props: z.object({ src: z.string(), alt: z.string().optional() }),
  description: `${pick("ImageBlock").description}. src must be a real http(s) product URL; private, loopback, credential-bearing, and non-http(s) URLs are rejected.`,
  component: (renderProps) => {
    if (!isSafeRemoteImageUrl(renderProps.props.src)) return null;
    return createElement(pick("ImageBlock").component as any, renderProps as any);
  },
});

const EimuImageGallery = defineComponent({
  name: "ImageGallery",
  props: z.object({
    images: z.array(
      z.object({
        src: z.string(),
        alt: z.string().optional(),
        details: z.string().optional(),
      }),
    ),
  }),
  description: `${pick("ImageGallery").description}. Every src must be a real http(s) product URL; unsafe entries are dropped and an all-unsafe gallery renders nothing.`,
  component: (renderProps) => {
    const images = filterSafeImageItems(renderProps.props.images).map((image) =>
      image.details
        ? { ...image, details: sanitizeMarkdownImages(image.details) }
        : image,
    );
    if (images.length === 0) return null;
    return createElement(pick("ImageGallery").component as any, {
      ...renderProps,
      props: { ...renderProps.props, images },
    } as any);
  },
});

/** 已被替换的组件 → 新 schema；供父级 union 引用。 */
const localOverrides: Record<string, AnyComponent> = {
  FormControl: EimuFormControl,
  Form: EimuForm,
  ImageBlock: EimuImageBlock,
  ImageGallery: EimuImageGallery,
  OptionCard: EimuOptionCard,
  OptionCards: EimuOptionCards,
};

const componentRef = (name: string) => (localOverrides[name] ?? pick(name)).ref;



const cardChildren = SELECTED.filter((name) => !CARD_CHILD_EXCLUDED.has(name)).map(componentRef);

const EimuCard = defineComponent({
  name: "Card",
  props: z.object({
    children: z.array(unionOf(cardChildren)),
    sources: z
      .array(
        z.object({
          url: z.string().optional(),
          title: z.string(),
          sourceName: z.string(),
        }),
      )
      .optional(),
  }),
  description: pick("Card").description,
  component: pick("Card").component,
});

localOverrides.Card = EimuCard;

const overrides: Record<string, AnyComponent> = localOverrides;

/**
 * 供 `<Renderer library={eimuLibrary}>` 使用。
 * 注意：用 `generateSystemPrompt` 时要传 `eimuLibrary.toSpec()`（LibrarySpec），
 * 直接传 Library 实例会得到 undefined 签名（已实测）。
 */
export const eimuLibrary = createLibrary({
  root: "Card",
  // 统一 wrapper 是 Markdown 图片剥离的唯一真源；新增组件自动获得覆盖。
  components: SELECTED.map((name) => wrapSanitized(overrides[name] ?? pick(name))),
});

const baseRules = openuiChatPromptOptions.additionalRules ?? [];

/**
 * Eimu 场景规则。保留 chat 库中与表单/图片/表格/按钮契约相关的条目，
 * 去掉指向未收录组件（Tabs、InlineHeader、Chips、DatePicker、charts、
 * FollowUpBlock）的条目，再补两条 Eimu 生图/生视频专用规则。
 */
export const eimuPromptOptions: PromptOptions = {
  // 示例由 tools/gen-openui-prompt.mts 统一追加（参数面板，逐字正确签名）。
  examples: [],
  additionalRules: [
    baseRules[1], // 每条回复一个 Card，children 自动纵向堆叠
    "For suggested next actions outside a form, use Buttons with secondary/tertiary Button actions (@ToAssistant); do not generate a generic related-queries list.",
    baseRules[9], // 每个字段一个 FormControl 引用
    baseRules[10], // Form(name, buttons, fields)
    baseRules[11], // 禁止 Form 嵌套 Form
    "CardHeader is the page-level heading — place it first in Card.",
    "Every image slot requires a REAL URL from a tool result, the conversation, or the user — never invent, guess, or template a URL, and never use loopback/private/intranet hosts; if no real URL exists, compose without image components.",
    "Never use Markdown image syntax (`![alt](url)`) or raw HTML `<img>` in any text or description; images are only allowed through the ImageBlock and ImageGallery components, with a real product URL already present in context.",
    baseRules[30], // Table 按列组织，各列长度一致
    baseRules[32], // 表单恰好一个 primary submit Button，无 reset
    "Prefer structured inputs (Select, RadioGroup, Slider, CheckBoxGroup, OptionCards) over free-text Input; label every FormControl and keep field names unique.",
    "Form inputs work ONLY inside a FormControl within a Form; for suggestions outside a form use a Button with a @ToAssistant action (secondary/tertiary variant).",
    baseRules[36], // Button 只做真实动作，不编造 URL
    // ── Eimu 专用 ──
    "Eimu: when the user asks to generate an image or video, render one Form with the needed fields (prompt TextArea, style Select, aspect RadioGroup, seconds Slider) and exactly one primary submit Button; label every control in the user's language.",
    "Eimu: render media only from real URLs already present in the conversation (ImageBlock for one result, ImageGallery for several); never invent or guess a URL.",
  ],
};

/**
 * 组件 → 位置参数属性名顺序（取自实际注册的 zod schema），供 repair.ts 把
 * 命名参数改回位置参数。与 Renderer 用的是同一批组件定义，天然一致。
 */
export const eimuArgOrder: ArgOrderMap = Object.fromEntries(
  Object.entries(eimuLibrary.components as Record<string, AnyComponent>).map(([name, comp]) => {
    const shape = (comp.props as unknown as { shape?: Record<string, unknown> }).shape ?? {};
    return [name, Object.keys(shape)];
  }),
);
