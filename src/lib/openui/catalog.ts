/**
 * OpenUI 组件白名单——唯一真源（2026-10-18）。
 *
 * 四处消费同一份清单，保证「网关提示词里允许的组件 = 前端能渲染的组件」：
 *   1. `eimu-library.ts`：按本清单注册渲染组件；
 *   2. `tools/gen-openui-prompt.mts`：生成网关 system prompt（签名 + 白名单行），
 *      并断言 prompt 里出现的组件集合与本清单逐一相等；
 *   3. `repair.ts`：模型写错名字时的别名/模糊映射目标集合；
 *   4. `agent-markdown.ts`：裸 DSL（未套围栏）识别的轻量判据。
 *
 * 本档必须保持零依赖（不 import react / @openuidev/*），因为 agent-markdown
 * 在主聊天 bundle 里，不能把 OpenUI 运行时拖进主包。
 */

/** 注册顺序即提示词里的签名顺序。 */
export const OPENUI_COMPONENTS = [
  // 布局 / 文本
  "Card",
  "CardHeader",
  "TextContent",
  "Callout",
  "Tag",
  "Separator",
  // 媒体 / 数据
  "ImageBlock",
  "ImageGallery",
  "Table",
  "Col",
  "Steps",
  "StepsItem",
  // 表单
  "Form",
  "FormControl",
  "Input",
  "TextArea",
  "Select",
  "SelectItem",
  "Slider",
  "RadioGroup",
  "RadioItem",
  "CheckBoxGroup",
  "CheckBoxItem",
  "OptionCards",
  "OptionCard",
  "Button",
  "Buttons",
  // Tag / OptionCard 的 schema 引用 Icon，必须注册
  "Icon",
] as const;

export type OpenUIComponentName = (typeof OPENUI_COMPONENTS)[number];

export const OPENUI_COMPONENT_SET: ReadonlySet<string> = new Set(OPENUI_COMPONENTS);

/** 内置动作（@Name）白名单。 */
export const OPENUI_ACTIONS = ["ToAssistant", "OpenUrl"] as const;

/**
 * 常见误名 → 白名单组件（key 一律小写、去掉 `_`/`-`）。
 * 值为白名单名时直接改名；值以 `text:` 开头表示「把参数里的文字收成
 * TextContent」，`image:` 表示「转成 ImageBlock(src, alt)」。
 */
export const OPENUI_COMPONENT_ALIASES: Record<string, string> = {
  // 容器 / 标题
  container: "Card",
  panel: "Card",
  header: "CardHeader",
  title: "CardHeader",
  heading: "CardHeader",
  cardtitle: "CardHeader",
  // 文本类（已从库中移除或模型臆造）→ TextContent
  text: "text:",
  boldtext: "text:",
  paragraph: "text:",
  markdown: "text:",
  markdownrenderer: "text:",
  inlineheader: "text:",
  icontext: "text:",
  label: "text:",
  codeblock: "text:",
  metricindicatorinline: "text:",
  subtitle: "text:",
  description: "text:",
  note: "text:",
  // 提示
  alert: "Callout",
  notice: "Callout",
  banner: "Callout",
  badge: "Tag",
  chip: "Tag",
  divider: "Separator",
  hr: "Separator",
  // 媒体
  image: "image:",
  img: "image:",
  picture: "image:",
  gallery: "ImageGallery",
  imagegrid: "ImageGallery",
  // 表单
  textfield: "Input",
  textinput: "Input",
  textbox: "Input",
  multilineinput: "TextArea",
  dropdown: "Select",
  picker: "Select",
  combobox: "Select",
  option: "SelectItem",
  selectoption: "SelectItem",
  dropdownitem: "SelectItem",
  range: "Slider",
  rangeslider: "Slider",
  radio: "RadioItem",
  radiobutton: "RadioItem",
  radiooption: "RadioItem",
  radiogroups: "RadioGroup",
  radios: "RadioGroup",
  checkbox: "CheckBoxItem",
  checkboxitem: "CheckBoxItem",
  checkboxes: "CheckBoxGroup",
  checkboxlist: "CheckBoxGroup",
  choice: "OptionCard",
  choicecard: "OptionCard",
  optioncarditem: "OptionCard",
  choices: "OptionCards",
  choicecards: "OptionCards",
  optiongrid: "OptionCards",
  field: "FormControl",
  formfield: "FormControl",
  formitem: "FormControl",
  btn: "Button",
  actionbutton: "Button",
  buttongroup: "Buttons",
  buttonrow: "Buttons",
  actions: "Buttons",
  btngroup: "Buttons",
  step: "StepsItem",
  stepitem: "StepsItem",
  column: "Col",
};

/** 动作误名 → 白名单动作（key 小写）。 */
export const OPENUI_ACTION_ALIASES: Record<string, string> = {
  toassistant: "ToAssistant",
  send: "ToAssistant",
  sendmessage: "ToAssistant",
  reply: "ToAssistant",
  submit: "ToAssistant",
  tochat: "ToAssistant",
  openurl: "OpenUrl",
  open: "OpenUrl",
  link: "OpenUrl",
  navigate: "OpenUrl",
};

/** 判定一行像不像 openui 语句的轻量正则（裸 DSL 识别用）。 */
export const OPENUI_ROOT_LINE_RE = /^\s*root\s*=\s*[A-Za-z_][\w]*\s*\(/;
export const OPENUI_STATEMENT_LINE_RE =
  /^\s*[A-Za-z_$][\w$]*\s*=\s*(?:[A-Za-z_][\w]*\s*\(|@[A-Za-z]|\[|\{|"|\$|-?\d|true\b|false\b|null\b)/;
