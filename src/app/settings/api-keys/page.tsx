import { ApiKeysClient } from "@/components/settings/ApiKeysClient";

const PAGE_TITLE = "API 密钥 · Eimu";
const PAGE_DESCRIPTION = "管理你的 Eimu API 密钥：创建、查看与吊销，用于 DSH 插件等第三方工具调用 /v1 接口。";

export const metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: "https://eimu.dev/settings/api-keys",
  },
};

export default function ApiKeysPage() {
  return <ApiKeysClient />;
}
