import type { Metadata } from "next";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import { StatusDashboard, type GatusEndpoint } from "./StatusDashboard";

const SITE_URL = getSiteUrlFromEnv();

const GATUS_STATUS_URL =
  "https://store.eimu.dev/gatus-api/endpoints/statuses";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "系统状态",
  description: "Eimu GPT Image 2 生成接口实时状态。",
  alternates: { canonical: `${SITE_URL}/status` },
};

async function getInitialStatus(): Promise<GatusEndpoint[]> {
  try {
    const response = await fetch(GATUS_STATUS_URL, { cache: "no-store" });
    if (!response.ok) return [];
    return (await response.json()) as GatusEndpoint[];
  } catch {
    return [];
  }
}

export default async function StatusPage() {
  return <StatusDashboard initialEndpoints={await getInitialStatus()} />;
}
