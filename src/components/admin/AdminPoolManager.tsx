"use client";

// /admin 外壳：左侧边栏导航 + 右侧内容。首屏（"总览"）是可视化仪表盘
// （矩形树状图 + 结果分布 + 渠道排行），文字密集的配置面板全部收进侧边栏其他项，
// 需要点击才会看到——不再用横向分页把图表和文字表格并排挤在同一屏。

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleDollarSign, KeyRound, LayoutDashboard, Layers3, LogOut, Route, ServerCog, Waypoints } from "lucide-react";
import { AdminHome } from "@/components/admin/AdminHome";
import { AdminModelPricing } from "@/components/admin/AdminModelPricing";
import { AdminRelayChannels } from "@/components/admin/AdminRelayChannels";
import { AdminBizKeys } from "@/components/admin/AdminBizKeys";
import { AdminRoutingPanel } from "@/components/admin/AdminRoutingPanel";
import { AdminTemplateManager } from "@/components/admin/AdminTemplateManager";

type NavKey = "home" | "relays" | "pricing" | "bizKeys" | "routing" | "templates";

const NAV_ITEMS: Array<{ key: NavKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: "home", label: "总览", icon: LayoutDashboard },
  { key: "relays", label: "中转渠道", icon: Waypoints },
  { key: "pricing", label: "模型定价", icon: CircleDollarSign },
  { key: "bizKeys", label: "B 端密钥", icon: KeyRound },
  { key: "routing", label: "路由调度", icon: Route },
  { key: "templates", label: "场景模板", icon: Layers3 },
];

export function AdminPoolManager({ username }: { username: string }) {
  const router = useRouter();
  const [nav, setNav] = useState<NavKey>("home");

  const logout = async () => {
    await fetch("/api/admin/session", { method: "DELETE" });
    router.refresh();
  };

  return (
    <main className="min-h-screen bg-[#f4f5f7] text-[#242830]">
      <header className="border-b border-black/10 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#20242c] text-white"><ServerCog className="h-4 w-4" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">服务管理</h1>
              <p className="truncate text-xs text-black/45">管理员 {username}</p>
            </div>
          </div>
          <button type="button" onClick={logout} title="退出登录" className="flex h-9 w-9 items-center justify-center rounded-md border border-black/10 text-black/55 hover:bg-black/5 hover:text-black">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto lg:w-52 lg:flex-col lg:gap-1 lg:overflow-visible">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setNav(key)}
              className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold lg:shrink lg:w-full ${
                nav === key ? "bg-[#20242c] text-white" : "text-black/55 hover:bg-black/5"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">
          {nav === "home" ? (
            <AdminHome />
          ) : nav === "relays" ? (
            <AdminRelayChannels />
          ) : nav === "pricing" ? (
            <AdminModelPricing />
          ) : nav === "bizKeys" ? (
            <AdminBizKeys />
          ) : nav === "templates" ? (
            <AdminTemplateManager />
          ) : (
            <AdminRoutingPanel onOpenRelays={() => setNav("relays")} />
          )}
        </div>
      </div>
    </main>
  );
}
