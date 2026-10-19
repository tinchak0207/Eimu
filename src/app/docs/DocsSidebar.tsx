"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, CreditCard, History, Plug, Rocket, Settings2, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";

const SECTIONS = [
  {
    label: "文档中心",
    items: [
      { href: "/docs", label: "快速上手", icon: BookOpen },
      { href: "/docs/assistant", label: "助理设定", icon: Settings2 },
      { href: "/docs/workflow", label: "工作流与画布", icon: Workflow },
      { href: "/docs/history", label: "历史素材复用", icon: History },
      { href: "/docs/billing", label: "充值与计费", icon: CreditCard },
      { href: "/docs/mcp", label: "把助理带走", icon: Plug },
      { href: "/docs/api", label: "开发进阶", icon: Rocket },
    ],
  },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/docs") return pathname === "/docs";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-full shrink-0 lg:sticky lg:top-24 lg:w-56" aria-label="文档目录">
      <nav className="flex flex-col gap-1">
        {SECTIONS.map((section) => (
          <div key={section.label}>
            <p className="px-3 pb-1.5 pt-1 text-ios-caption1 font-semibold tracking-wide text-[rgba(0,0,0,0.48)]">
              {section.label}
            </p>
            <ul className="flex flex-row gap-1 lg:flex-col">
              {section.items.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href} className="flex-1 lg:flex-none">
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-ios-xl px-3 py-2.5 text-ios-footnote font-medium lg:justify-start lg:px-3.5",
                        active
                          ? "bg-[rgba(0,122,255,0.10)] text-[#007AFF]"
                          : "text-[rgba(0,0,0,0.62)] hover:bg-[rgba(0,122,255,0.06)] hover:text-[rgba(0,0,0,0.82)]",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}
