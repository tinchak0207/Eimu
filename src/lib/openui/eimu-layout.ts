/**
 * OpenUI 富展示：布局 / 文本原语（2026-10-18）。
 *
 * 组件划分与 props 设计参考 thesysdev/open-intelligent-ui（MIT License,
 * Copyright (c) 2026 Thesys Inc.）的 src/lib/components/layout.tsx 与 text.tsx，
 * 按 Eimu 的需要收窄：去掉 Form / Pressable / 任意 CSS 颜色与尺寸（防模型注入样式），
 * 颜色只收固定 token，间距只收 0-8 档。许可证全文见同目录 THIRD_PARTY_NOTICES.md。
 *
 * 与 eimu-library.ts 相同的约束：会被 Node 脚本（gen-openui-prompt）require，
 * 不 import CSS / JSX；样式在 src/styles/openui-eimu.css（.eimu-oui-*）。
 * 文字值可能来自 Query 字段引用：取不到（undefined / 空串）时该组件不渲染，绝不补默认文案。
 */
import { createElement as h, Fragment, useState, type ReactNode } from "react";
import { defineComponent, tagSchemaId, type DefinedComponent } from "@openuidev/react-lang";
import { z } from "zod/v4";

type AnyComponent = DefinedComponent<any>;
type RenderNode = (value: unknown) => ReactNode;

/** 子节点槽：任意白名单组件或其数组。提示词里印作 `Node[]`。 */
const node = z.any();
tagSchemaId(node, "Node");
export const nodeChildren = z.array(node);

const align = z.enum(["start", "center", "end", "stretch"]);
const justify = z.enum(["start", "center", "end", "between"]);
const FLEX: Record<string, string> = {
  start: "flex-start",
  end: "flex-end",
  center: "center",
  stretch: "stretch",
  between: "space-between",
};

/** 间距档 0-8 → 4px 步长；越界/非数字视为未设置。 */
export function gapPx(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${Math.min(8, Math.max(0, Math.round(value))) * 4}px`;
}

/** 字段引用取不到时得到 undefined/null/空串：统一视为「无内容」。 */
export function textValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ") || undefined;

export const Row = defineComponent({
  name: "Row",
  props: z.object({
    children: nodeChildren,
    gap: z.number().optional(),
    align: align.optional(),
    justify: justify.optional(),
    wrap: z.boolean().optional(),
  }),
  description: "Horizontal layout; on phones it wraps when wrap is true.",
  component: ({ props, renderNode }) =>
    h(
      "div",
      {
        className: "eimu-oui-row",
        style: {
          gap: gapPx(props.gap),
          alignItems: props.align ? FLEX[props.align] : undefined,
          justifyContent: props.justify ? FLEX[props.justify] : undefined,
          flexWrap: props.wrap ? "wrap" : undefined,
        },
      },
      (renderNode as RenderNode)(props.children),
    ),
});

export const Grid = defineComponent({
  name: "Grid",
  props: z.object({
    children: nodeChildren,
    columns: z.number().optional(),
    gap: z.number().optional(),
  }),
  description: "Equal columns (default 2, max 4); drops to fewer columns on narrow screens.",
  component: ({ props, renderNode }) => {
    const columns = Math.min(4, Math.max(1, Math.round(typeof props.columns === "number" ? props.columns : 2)));
    return h(
      "div",
      { className: "eimu-oui-grid", "data-cols": columns, style: { gap: gapPx(props.gap) } },
      (renderNode as RenderNode)(props.children),
    );
  },
});

export const Box = defineComponent({
  name: "Box",
  props: z.object({
    children: nodeChildren,
    direction: z.enum(["col", "row"]).optional(),
    tone: z.enum(["plain", "soft", "outline"]).optional(),
    gap: z.number().optional(),
    align: align.optional(),
  }),
  description: "Group block; col by default. tone soft = filled panel, outline = bordered panel.",
  component: ({ props, renderNode }) =>
    h(
      "div",
      {
        className: cx(
          "eimu-oui-box",
          props.direction === "row" ? "eimu-oui-row" : "eimu-oui-col",
          props.tone === "soft" && "eimu-oui-soft",
          props.tone === "outline" && "eimu-oui-outline",
        ),
        style: { gap: gapPx(props.gap), alignItems: props.align ? FLEX[props.align] : undefined },
      },
      (renderNode as RenderNode)(props.children),
    ),
});

export const Carousel = defineComponent({
  name: "Carousel",
  props: z.object({ children: nodeChildren }),
  description: "Horizontal swipe strip; each child is one slide.",
  component: ({ props, renderNode }) => {
    const items = (Array.isArray(props.children) ? props.children.flat() : [props.children]).filter((x) => x != null);
    return h(
      "div",
      { className: "eimu-oui-carousel", role: "list" },
      items.map((child, i) => h("div", { key: i, className: "eimu-oui-slide", role: "listitem" }, (renderNode as RenderNode)(child))),
    );
  },
});

type ElementLike = { type?: string; typeName?: string; props?: Record<string, unknown> };
const isElement = (value: unknown, typeName: string): value is ElementLike =>
  !!value && typeof value === "object" && (value as ElementLike).type === "element" && (value as ElementLike).typeName === typeName;

export const TabItem = defineComponent({
  name: "TabItem",
  props: z.object({ label: z.string(), children: nodeChildren }),
  description: "One tab of Tabs: label + its content.",
  component: ({ props, renderNode }) => h(Fragment, null, (renderNode as RenderNode)(props.children)),
});

function TabsView({ items, renderNode }: { items: ElementLike[]; renderNode: RenderNode }) {
  const [active, setActive] = useState(0);
  const current = items[Math.min(active, items.length - 1)];
  return h(
    "div",
    { className: "eimu-oui-tabs" },
    h(
      "div",
      { className: "eimu-oui-tablist", role: "tablist" },
      items.map((item, i) =>
        h(
          "button",
          {
            key: i,
            type: "button",
            role: "tab",
            "aria-selected": i === active,
            className: cx("eimu-oui-tab", i === active && "is-active"),
            onClick: () => setActive(i),
          },
          textValue(item.props?.label) || `${i + 1}`,
        ),
      ),
    ),
    h("div", { className: "eimu-oui-tabpanel", role: "tabpanel" }, current ? renderNode(current.props?.children) : null),
  );
}

export const Tabs = defineComponent({
  name: "Tabs",
  props: z.object({ items: z.array(TabItem.ref) }),
  description: "Tabbed views (2-5 tabs), e.g. 成片 / 分镜 / 过程.",
  component: ({ props, renderNode }) => {
    const items = (Array.isArray(props.items) ? props.items.flat() : []).filter((x: unknown) => isElement(x, "TabItem")).slice(0, 5) as ElementLike[];
    if (items.length === 0) return null;
    return h(TabsView, { items, renderNode: renderNode as RenderNode });
  },
});

const TITLE_LEVEL: Record<string, number> = { xl: 2, lg: 2, md: 3, sm: 4 };

export const Title = defineComponent({
  name: "Title",
  props: z.object({ text: z.string(), size: z.enum(["sm", "md", "lg", "xl"]).optional() }),
  description: "Heading; md for a block title, lg for a section.",
  component: ({ props }) => {
    const text = textValue(props.text);
    if (!text) return null;
    const size = props.size ?? "md";
    return h("div", { role: "heading", "aria-level": TITLE_LEVEL[size] ?? 3, className: `eimu-oui-title eimu-oui-title-${size}` }, text);
  },
});

export const Caption = defineComponent({
  name: "Caption",
  props: z.object({ text: z.string() }),
  description: "Small secondary text.",
  component: ({ props }) => {
    const text = textValue(props.text);
    return text ? h("p", { className: "eimu-oui-caption" }, text) : null;
  },
});

export const BADGE_COLORS = ["neutral", "info", "success", "warning", "danger", "purple"] as const;

export const Badge = defineComponent({
  name: "Badge",
  props: z.object({ text: z.string(), color: z.enum(BADGE_COLORS).optional() }),
  description: "Pill fact tag. Numbers only via Query fields (e.g. Badge(meta.duration)).",
  component: ({ props }) => {
    const text = textValue(props.text);
    if (!text) return null;
    const color = (BADGE_COLORS as readonly string[]).includes(String(props.color)) ? props.color : "neutral";
    return h("span", { className: `eimu-oui-badge eimu-oui-badge-${color}` }, text);
  },
});

export const ListItem = defineComponent({
  name: "ListItem",
  props: z.object({
    title: z.string(),
    description: z.string().optional(),
    marker: z.string().optional(),
  }),
  description: "List row; marker replaces the bullet (an emoji or short label).",
  component: ({ props }) =>
    h(
      "div",
      { className: "eimu-oui-list-body" },
      h("div", { className: "eimu-oui-list-title" }, textValue(props.title)),
      textValue(props.description) ? h("div", { className: "eimu-oui-list-desc" }, textValue(props.description)) : null,
    ),
});

export const List = defineComponent({
  name: "List",
  props: z.object({
    items: z.array(z.union([z.string(), ListItem.ref])),
    marker: z.enum(["bullet", "number", "none"]).optional(),
    timeline: z.boolean().optional(),
  }),
  description: "Bullet / numbered list; timeline joins markers with a line (process recap).",
  component: ({ props, renderNode }) => {
    const items = (Array.isArray(props.items) ? props.items.flat() : []).filter((x: unknown) => x != null) as unknown[];
    if (items.length === 0) return null;
    const marker = props.marker ?? (props.timeline ? "none" : "bullet");
    const Tag = marker === "number" ? "ol" : "ul";
    return h(
      Tag,
      { className: cx("eimu-oui-list", `eimu-oui-list-${marker}`, props.timeline && "eimu-oui-timeline") },
      items.map((item, i) => {
        const el = isElement(item, "ListItem") ? item : null;
        const custom = el ? textValue(el.props?.marker) : "";
        return h(
          "li",
          { key: i },
          h("span", { className: "eimu-oui-list-marker", "aria-hidden": !custom }, custom || (marker === "number" ? `${i + 1}` : "")),
          el ? (renderNode as RenderNode)(el) : h("div", { className: "eimu-oui-list-body" }, h("div", { className: "eimu-oui-list-title" }, textValue(item))),
        );
      }),
    );
  },
});

export const layoutComponents: Record<string, AnyComponent> = {
  Row,
  Grid,
  Box,
  Carousel,
  Tabs,
  TabItem,
  Title,
  Caption,
  Badge,
  List,
  ListItem,
};
