import type { Metadata } from "next";
import { Inter, Bricolage_Grotesque } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cursor × Briefcase · Credits & Hackathon",
  description: "Cursor credits redemption and London 2026 hackathon hub",
  themeColor: "#111827",
  icons: {
    icon: [
      { url: "/cursor-cube-briefcase-32.png", sizes: "32x32", type: "image/png" },
      { url: "/cursor-cube-briefcase-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/cursor-cube-briefcase-32.png", sizes: "32x32", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${inter.variable} ${bricolage.variable} event-canvas`}>{children}</body>
    </html>
  );
}
