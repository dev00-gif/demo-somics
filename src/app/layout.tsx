import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MQTT Station — Gửi bản tin & file nhạc",
  description: "Upload bản tin / file nhạc, đẩy lên MQTT cho thiết bị nhúng phát",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="vi">
      <body className="antialiased">{children}</body>
    </html>
  );
}
