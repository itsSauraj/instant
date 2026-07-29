import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Instant | private peer-to-peer sessions",
  description:
    "Share notes, files and live audio or video directly between two browsers. No accounts, no database, nothing stored on a server.",
  robots: { index: true, follow: false },
};

export const viewport: Viewport = {
  // Matches --background in globals.css for each mode.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfafd" },
    { media: "(prefers-color-scheme: dark)", color: "#05060f" },
  ],
};

const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem('instant-theme');
  var dark = stored ? stored === 'dark' : !window.matchMedia('(prefers-color-scheme: light)').matches;
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {
  document.documentElement.classList.add('dark');
}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Applied before first paint so the page never flashes the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} min-h-dvh font-sans`}>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
