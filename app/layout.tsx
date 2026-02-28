import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  description: "CommBank PDF parser and category analytics dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <div className="min-h-screen bg-slate-50">
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3 sm:px-8">
              <div className="text-sm font-semibold text-slate-900">
                Personal Cashflow MVP
              </div>
              <nav className="flex items-center gap-5 text-sm text-slate-600">
                <Link href="/onboarding" className="font-medium text-slate-900 hover:text-blue-700">
                  Onboarding
                </Link>
                <Link href="/phase3" className="font-medium text-slate-900 hover:text-blue-700">
                  Report
                </Link>
                <Link href="/inbox" className="font-medium text-slate-900 hover:text-blue-700">
                  Inbox
                </Link>
                <Link href="/settings" className="font-medium text-slate-900 hover:text-blue-700">
                  Settings
                </Link>
                <a
                  href="/api/analysis/export?type=transactions&format=csv&scope=all&showTransfers=excludeMatched"
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  Export
                </a>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
