import { LocalFilesClient } from "@/components/settings/LocalFilesClient";

const PAGE_TITLE = "本机文件 · Eimu";
const PAGE_DESCRIPTION = "授权 Eimu 桌面版读取本机文件夹，让 agent 能在你指定的范围内读档；支持随时开启或关闭。";

export const metadata = {
  title: { absolute: PAGE_TITLE },
  // 個人頁（裝置相關）：不進索引。
  robots: { index: false, follow: false },
  description: PAGE_DESCRIPTION,
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: "https://eimu.dev/settings/local-files",
  },
};

export default function LocalFilesPage() {
  return <LocalFilesClient />;
}