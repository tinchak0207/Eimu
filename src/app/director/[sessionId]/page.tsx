import type { Metadata } from "next";
import { DirectorStageClient } from "./DirectorStageClient";

// 全屏导演台（3D 统一方案 P2）：读写 agent 的同一份导演场景文档（网关 director-store），
// 视口复用 DirectorMiniViewport（同一个 director-engine/engine.ts），agent 改动经轮询 revision 实时刷新。
// 需要登录（state 走站内代理鉴权），不进索引。

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "导演台", robots: { index: false, follow: false } };

export default async function DirectorStagePage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <DirectorStageClient sessionId={sessionId} />;
}
