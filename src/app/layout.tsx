import type { Metadata } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/react";
import { AuthProvider } from "@/hooks/use-auth";
import { Navbar } from "@/components/Navbar";
import { PricingSync } from "@/components/PricingSync";
import { PwaInstaller } from "@/components/PwaInstaller";
import { Toaster } from "@/components/ui/toaster";
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

const SITE_TITLE = "Emu — AI 图片与视频创作";
const SITE_DESCRIPTION =
  "Emu：在线生成 GPT Image 2、Nano Banana Pro 图片与视频，登录即用，不用注册中转站，也不用申请 API Key。";

export const metadata: Metadata = {
  metadataBase: new URL("https://image.tinchak0207.xyz"),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  keywords: [
    "Emu",
    "AI生图",
    "AI 在线生图",
    "GPT Image 2",
    "Nano Banana Pro",
    "图片生成器",
    "AI画图工具",
  ],
  openGraph: {
    type: "website",
    locale: "zh_CN",
    url: "https://image.tinchak0207.xyz",
    siteName: "Emu",
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
    title: "Emu",
  },
  formatDetection: {
    telephone: false,
  },
};

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Emu",
  alternateName: "image.tinchak0207.xyz",
  url: "https://image.tinchak0207.xyz",
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
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased text-[15px] text-foreground">
        <script
          type="application/ld+json"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
        />
        <AuthProvider>
          <PricingSync />
          <Navbar />
          <main>{children}</main>
          <Toaster />
          <PwaInstaller />
        </AuthProvider>
        <Analytics />
      </body>
    </html>
  );
}
