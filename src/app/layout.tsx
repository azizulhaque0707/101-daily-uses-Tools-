import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Navbar } from "@/components/layout/navbar";
import { Footer } from "@/components/layout/footer";
import { TooltipProvider } from "@/components/ui/overlay";
import { TOOL_COUNT } from "@/lib/tools/registry";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono-jet",
});

export const metadata: Metadata = {
  title: {
    default: `BrowserForge — ${TOOL_COUNT} free online tools that never upload your files`,
    template: "%s | BrowserForge",
  },
  description: `${TOOL_COUNT} privacy-first online tools for images, PDFs, documents, video, audio and utilities. Every file is processed locally inside your browser.`,
  applicationName: "BrowserForge",
  keywords: [
    "online tools",
    "free tools",
    "image compressor",
    "pdf merger",
    "video trimmer",
    "audio converter",
    "privacy",
    "browser tools",
  ],
  openGraph: {
    title: "BrowserForge — free browser-based tools",
    description:
      `Compress, convert, merge and edit files without uploading them anywhere. ${TOOL_COUNT} tools, zero servers involved.`,
    type: "website",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#101018" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body className="flex min-h-screen flex-col bg-canvas text-ink antialiased">
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            <a
              href="#main"
              className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-brand focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--brand-ink)]"
            >
              Skip to content
            </a>
            <Navbar />
            <main id="main" className="flex-1">
              {children}
            </main>
            <Footer />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
