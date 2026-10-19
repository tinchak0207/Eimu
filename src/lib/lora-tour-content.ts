export const LORA_TOUR_STORAGE_KEY = "lora-tour-v1";

/** 已废弃（2026-08-27 专业工作站入口移除）：保留常量避免旧 localStorage 语义漂移。 */
export const PRO_LORA_TOUR_ARMED_KEY = "pro-lora-tour-armed";

export interface LoraTourStepContent {
  title: string;
  lines: string[];
  image: boolean;
}

export const LORA_TOUR_CONTENT: LoraTourStepContent[] = [
  {
    title: "PixAI 社区",
    lines: [
      "PixAI 是二次元 AI 绘画社区，模型由社区成员训练，画质很有口碑。",
      "你现在 hover 的这个目录，就是我们在用的 PixAI 系列模型。",
      "社区里还有一种轻量风格模型，叫 LoRA——不换底模就能叠加画风，下面会讲到。",
    ],
    image: true,
  },
  {
    title: "适用场景",
    lines: [
      "想要特定角色的立绘或同人图。",
      "想要特定画师风格、扁平上色或厚涂质感。",
      "想要某类细节——眼睛、头发、机甲、背景质感。",
    ],
    image: true,
  },
  {
    title: "去哪里选",
    lines: [
      "AI 助理的画布顶栏有「LoRA」按钮，点开就是 LoRA 库。",
      "搜索、按分类浏览，点卡片即选中，一次选一个。",
      "选中的 LoRA 会自动带入画布的每一次生成。",
    ],
    image: false,
  },
];

export function buildLoraTourDescription(
  popover: { description: HTMLElement },
  content: LoraTourStepContent,
): void {
  const description = popover.description;
  description.innerHTML = "";
  for (const line of content.lines) {
    const p = document.createElement("p");
    p.style.margin = "0 0 6px 0";
    p.style.fontSize = "13px";
    p.style.lineHeight = "1.55";
    p.style.color = "rgba(0,0,0,0.62)";
    p.textContent = line;
    description.appendChild(p);
  }
  if (content.image) {
    const figure = document.createElement("img");
    figure.src = "/lora-tour-example.png";
    figure.alt = "LoRA 效果示例";
    figure.style.display = "block";
    figure.style.width = "100%";
    figure.style.height = "120px";
    figure.style.objectFit = "cover";
    figure.style.borderRadius = "14px";
    figure.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,0.7)";
    description.appendChild(figure);
  }
}
