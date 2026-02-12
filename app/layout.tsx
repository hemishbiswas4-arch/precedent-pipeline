import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Precedent Finder",
  description:
    "Automated legal precedent triage for HC/SC case discovery from natural language fact scenarios.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
