import type { Metadata } from "next";
import { redirect } from "next/navigation";

// 旧书签 /agent 由 next.config redirects 送到 /?agent=1。
// 这里再留一次服务端 redirect，配置未生效时也不会停在客户端假跳转。

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AgentPage() {
  redirect("/?agent=1");
}
