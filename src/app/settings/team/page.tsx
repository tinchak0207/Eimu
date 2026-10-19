import { TeamConsoleClient } from "@/components/settings/TeamConsoleClient";

const PAGE_TITLE = "团队管理 · Eimu";
const PAGE_DESCRIPTION = "团队席位、成员角色、建画布权限、加入审批、解散冷静期与用量：走 B 端接口的团队治理控制台。";

export const metadata = {
  title: { absolute: PAGE_TITLE },
  // 个人页（需登入 + B 端密钥）：不进索引，别浪费爬取预算。
  robots: { index: false, follow: false },
  description: PAGE_DESCRIPTION,
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: "https://eimu.dev/settings/team",
  },
};

export default function TeamSettingsPage() {
  return <TeamConsoleClient />;
}
