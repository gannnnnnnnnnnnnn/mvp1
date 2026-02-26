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
                <Link href="/" className="font-medium text-slate-900 hover:text-blue-700">
                  Home
                </Link>
                <Link href="/phase3" className="font-medium text-slate-900 hover:text-blue-700">
                  Dataset
                </Link>
                <Link href="/phase3/compare" className="font-medium text-slate-900 hover:text-blue-700">
                  Compare
                </Link>
                <Link href="/transactions" className="hover:text-slate-900">
                  Workspace
                </Link>
                <Link href="/settings" className="hover:text-slate-900">
                  Settings
                </Link>
                <details className="group relative">
                  <summary className="list-none cursor-pointer text-xs text-slate-400 hover:text-slate-600">
                    Legacy
                  </summary>
                  <div className="absolute right-0 z-20 mt-2 w-40 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm">
                    <Link href="/dashboard" className="block rounded px-2 py-1 text-slate-600 hover:bg-slate-100">
                      Dashboard
                    </Link>
                    <Link href="/phase3/month" className="block rounded px-2 py-1 text-slate-600 hover:bg-slate-100">
                      Month (legacy)
                    </Link>
                  </div>
                </details>
              </nav>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
