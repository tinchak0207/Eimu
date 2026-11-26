"use client";

/**
 * 左上角「资料库」面板顶部的三段切换：对话 / 作品 / 资产。
 * 对话历史、我的作品（含项目与生成记录）、我的资产本质同一件事——「我做过的东西」，
 * 入口收成一颗按钮，面板内用这条分段切换，不再各占一个入口。
 */
export type LibraryTab = "chat" | "works" | "assets";

const TABS: ReadonlyArray<{ key: LibraryTab; label: string }> = [
  { key: "chat", label: "对话" },
  { key: "works", label: "作品" },
  { key: "assets", label: "资产" },
];

export function AgentLibraryTabs({
  active,
  onPick,
}: {
  active: LibraryTab;
  onPick: (tab: LibraryTab) => void;
}) {
  return (
    <div role="tablist" aria-label="资料库" className="mx-1 mb-1 flex gap-0.5 rounded-full bg-black/5 p-0.5">
      {TABS.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onPick(tab.key)}
          className={
            "min-h-9 flex-1 cursor-pointer rounded-full px-3 text-ios-caption1 font-medium outline-none transition-colors " +
            (active === tab.key ? "bg-white text-foreground shadow-sm" : "text-foreground/55 hover:text-foreground/80")
          }
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
