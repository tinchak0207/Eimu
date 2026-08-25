import type { AgentTemplate, AgentTemplateDomain } from "@/lib/agent-templates";
import { AGENT_TEMPLATE_DOMAIN_LABELS } from "@/lib/agent-templates";

export interface AgentTemplateGalleryProps {
  /** 起手模板清單（由上層注入，組件不自取 AGENT_TEMPLATES——保持可測試）。 */
  templates: AgentTemplate[];
  /** 點整卡即動作：注入 initialPrompt + 鋪 workflow。 */
  onUseTemplate: (template: AgentTemplate) => void;
}

/** 領域分組順序：小說 → 电商 → 短剧 → 艺术（AGENT_TEMPLATE_DOMAIN_LABELS 的既定序）。 */
const DOMAIN_ORDER: AgentTemplateDomain[] = ["novel", "ecommerce", "shortdrama", "art"];

/**
 * 助理初始配置的右側模板庫（2026-08-25）：canvas 空且無對話時的初始態。
 * 卡即動作——每卡只有 name + painPoint 兩行，點整卡觸發 onUseTemplate，
 * 沒有「查看詳情」按鈕、沒有計數徽章。極簡原則：每個可見元素都有大用。
 */
export function AgentTemplateGallery({ templates, onUseTemplate }: AgentTemplateGalleryProps) {
  if (templates.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="text-ios-footnote text-[rgba(0,0,0,0.45)]">
          模板尚未就绪，直接在左侧对 AI 助理说出你的想法
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain px-5 py-6 sm:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-7">
        <header>
          <h2 className="text-ios-title3 font-semibold text-foreground">选一个起点</h2>
          <p className="mt-1 text-ios-footnote text-[rgba(0,0,0,0.5)]">
            点一张卡：模板工作流直接铺到画布，AI 助理开始按它帮你出图
          </p>
        </header>
        {DOMAIN_ORDER.map((domain) => {
          const group = templates.filter((t) => t.domain === domain);
          if (group.length === 0) return null;
          return (
            <section key={domain} aria-label={AGENT_TEMPLATE_DOMAIN_LABELS[domain]}>
              <h3 className="mb-2.5 text-ios-headline font-semibold text-foreground">
                {AGENT_TEMPLATE_DOMAIN_LABELS[domain]}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => onUseTemplate(template)}
                    className="lg-card group flex cursor-pointer flex-col gap-1.5 rounded-ios-2xl p-4 text-left transition-colors duration-200 hover:bg-[rgba(0,0,0,0.03)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                  >
                    <span className="text-[15px] font-semibold leading-snug text-foreground">
                      {template.name}
                    </span>
                    <span className="text-[13px] leading-[1.5] text-[rgba(0,0,0,0.55)]">
                      {template.painPoint}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
