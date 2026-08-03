import type { Metadata } from "next";
import "./globals.css";

// The title is a TEMPLATE, not a flat string (EC-09). A flat string on the ROOT
// layout is inherited by every page in the app, so the sign-in copy leaked onto
// authenticated chat pages' browser tab and print header. Each route now names
// itself (`app/page.tsx` -> "Sign in", `app/app/layout.tsx` -> "Workspace") and
// `default` covers any route that declares nothing.
export const metadata: Metadata = {
  title: { default: "MicroManus", template: "%s · MicroManus" },
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
