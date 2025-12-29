import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "三语通",
  description: "中 / 英 / 德 三语互译（千问 Qwen-MT）",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh">
      <body>{children}</body>
    </html>
  );
}
