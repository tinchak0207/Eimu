import Link from "next/link";

/**
 * 「作品库」的两个视图：作品（成片与镜头版本）／生成记录（每一次出图与花费，含项目与资产筛选）。
 * 本质是同一件东西——「我做出来的东西」——所以导航里只留一个入口，这里切视图（2026-11-25 暴君裁定）。
 */
export function WorksTabs({ active }: { active: "works" | "history" }) {
  const base = "inline-flex min-h-9 items-center rounded-full px-4 text-sm font-medium transition";
  return (
    <div role="tablist" aria-label="作品库" className="mb-4 inline-flex gap-1 rounded-full bg-black/[0.05] p-1">
      <Link href="/works" role="tab" aria-selected={active === "works"} className={`${base} ${active === "works" ? "bg-white text-foreground shadow-sm" : "text-foreground/55 hover:text-foreground"}`}>作品</Link>
      <Link href="/history" role="tab" aria-selected={active === "history"} className={`${base} ${active === "history" ? "bg-white text-foreground shadow-sm" : "text-foreground/55 hover:text-foreground"}`}>生成记录</Link>
    </div>
  );
}
