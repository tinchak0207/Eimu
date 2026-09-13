import type { Metadata } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/react";
import { AuthProvider } from "@/hooks/use-auth";
import { Navbar } from "@/components/Navbar";
import { PricingSync } from "@/components/PricingSync";
import { PwaInstaller } from "@/components/PwaInstaller";
import { Toaster } from "@/components/ui/toaster";
import { getSiteUrlFromEnv } from "@/lib/site-url";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  display: "swap",
});

const SITE_TITLE = "Eimu — AI 图片与视频创作";
const SITE_DESCRIPTION =
  "Eimu：在线生成 GPT Image 2、Nano Banana Pro 图片与视频，登录即用，不用注册中转站，也不用申请 API Key。";

const SITE_URL = getSiteUrlFromEnv();

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: [
    "Eimu",
    "Eimu AI",
    "AI生图",
    "AI 在线生图",
    "GPT Image 2",
    "Nano Banana Pro",
    "图片生成器",
    "AI画图工具",
  ],
  alternates: { canonical: SITE_URL },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: SITE_URL,
    siteName: "Eimu",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Eimu",
  },
  formatDetection: {
    telephone: false,
  },
};

function getStructuredData() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Eimu",
    alternateName: SITE_URL.replace(/^https?:\/\//, ""),
    url: SITE_URL,
    applicationCategory: "DesignApplication",
    operatingSystem: "Web",
    description: SITE_DESCRIPTION,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "CNY",
      lowPrice: "9.9",
      highPrice: "69",
      offerCount: "3",
    },
    featureList: [
      "GPT Image 2 在线生图",
      "Nano Banana Pro 在线生图",
      "无需注册中转站或申请 API Key",
      "登录即用，生成后直接下载",
    ],
  };
}

/** Next 15 將 viewport 欄位從 metadata 拆出獨立 export（含 themeColor）。 */
export const viewport = {
  width: "device-width" as const,
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#1f2328",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const structuredData = getStructuredData();

  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased text-[15px] text-foreground flex min-h-dvh flex-col">
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
try{
window.__bootErrors=[];
window.addEventListener("error",function(e){window.__bootErrors.push(String(e.message).slice(0,300));try{localStorage.setItem("eimu_boot_err",JSON.stringify({t:Date.now(),m:String(e.message).slice(0,300),src:(e.filename||"").slice(-60)}))}catch(_){}});

window.addEventListener("unhandledrejection",function(e){window.__bootErrors.push("rej:"+String(e.reason).slice(0,200));});
setTimeout(function(){
  var w=window;
  if(w.__eimuHydrated)return;
  if(sessionStorage.getItem("eimu_selfheal"))return;
  sessionStorage.setItem("eimu_selfheal","1");
  (async function(){
    try{
      var regs=await navigator.serviceWorker.getRegistrations();
      for(var i=0;i<regs.length;i++)regs[i].unregister();
      var keys=await caches.keys();
      for(var j=0;j<keys.length;j++)await caches.delete(keys[j]);
      localStorage.setItem("eimu_boot_err",JSON.stringify({t:Date.now(),m:"self-heal: no hydration, cleared SW+caches"}));
      location.reload();
    }catch(_){}
  })();
},6000);
}catch(_){}
})();`,
          }}
        />
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
        <AuthProvider>
          <PricingSync />
          <Navbar />
          {/* 首頁應用式滿屏（2026-09-10 F6）：body 是 flex 縱向殼（Navbar 自然高
              ＋ main 吃滿剩餘視口）。min-h-dvh 而非 h-dvh——視口過矮時 body 可
              長高、整頁滾動。其他頁面是文檔流根節點，作為 flex item 只是全寬
              自然高，行為等價 block。Toaster/PwaInstaller/Analytics 渲染 fixed
              或 null，不參與 flex 佈局。 */}
          <main className="flex min-h-0 flex-1 flex-col">{children}</main>
          <Toaster />
          <PwaInstaller />
        </AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
