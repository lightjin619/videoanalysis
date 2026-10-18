import type { Metadata } from "next";
import "./globals.css";
import AppHeader from "@/components/AppHeader";

export const metadata: Metadata = {
  title: "Video Analysis Lab",
  description: "RGB-based video analysis platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>
        <AppHeader />
        <main className="app-main">{children}</main>
      </body>
    </html>
  );
}
