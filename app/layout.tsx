import type { Metadata } from "next";
import Script from "next/script";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const displayFont = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
});

const bodyFont = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Precedent Finder",
  description: "Consumer-first legal precedent discovery across Supreme Court and High Court judgments.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${displayFont.variable} ${bodyFont.variable} antialiased`}>
        <Script id="theme-init" strategy="beforeInteractive">
          {`(() => {
            try {
              const stored = localStorage.getItem('pf_theme');
              const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
              const next = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
              document.documentElement.dataset.theme = next;
            } catch {
              document.documentElement.dataset.theme = 'light';
            }
          })();`}
        </Script>
        {children}
      </body>
    </html>
  );
}
