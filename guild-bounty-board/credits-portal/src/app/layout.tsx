import type { Metadata } from "next";
import { Inter, Bricolage_Grotesque, Inter_Tight } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
  weight: ["500", "600", "700"],
});

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cursor credits",
  description: "Cursor credits redemption — standard /redeem flow for every hackathon deploy",
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
      <body
        className={`${inter.variable} ${interTight.variable} ${bricolage.variable} credits-canvas event-canvas`}
      >
        {children}
      </body>
    </html>
  );
}
