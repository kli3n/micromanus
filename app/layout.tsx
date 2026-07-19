import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MicroManus — Sign in",
  description:
    "A deep-research agent that browses the web, cites every source, and tells you exactly what each answer cost — on your own API key.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* Inter font stack + warm design tokens are applied via app/globals.css :root/body */}
      <body>{children}</body>
    </html>
  );
}
