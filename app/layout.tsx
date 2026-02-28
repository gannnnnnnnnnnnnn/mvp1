import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AppShellNav } from "@/components/app/AppShellNav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Personal Cashflow MVP",
  description: "Local-first personal cashflow reporting from bank statements",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} bg-[#f6f7f3] text-slate-900 antialiased`}>
        <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.92),_rgba(246,247,243,1)_52%)]">
          <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/70 backdrop-blur-xl">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
              <AppShellNav />
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
