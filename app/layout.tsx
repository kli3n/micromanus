import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Inter is served as a VARIABLE font: no weight option is passed, because the
// design system's closed weight set (400/550/600/650/700) includes 550 and 650,
// which are not members of next/font's static weight union — a static array
// would silently snap or synthesise them. The variable font carries the full
// wght axis, so font-[550] and font-[650] render as real weights.
//
// The CSS variable is deliberately --font-inter, NOT --sans: the generated
// class sets the property on <html> while :root { --sans } in globals.css sets
// it on the same element at equal specificity, which would leave the winner to
// stylesheet source order. globals.css resolves --sans through var(--font-inter).
//
// Operational risk, recorded here rather than only in planning docs:
// next/font's Google loader fetches the font files at BUILD time, so
// `next build` has a network dependency on Google Fonts. A hiccup during a
// pre-submission deploy would be a build failure at the worst moment. The
// hermetic escape hatch is next/font/local with a committed .woff2 — a small,
// isolated inversion if risk tolerance drops near submission.
const inter = Inter({
  subsets: ["latin"], // required whenever preload is on
  display: "swap",
  variable: "--font-inter",
  adjustFontFallback: true, // metric-matched fallback face -> zero swap CLS
});

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
    <html lang="en" className={inter.variable}>
      {/* Inter is self-hosted + preloaded via next/font (the class above sets
          --font-inter, which app/globals.css --sans resolves through); the warm
          design tokens are applied via app/globals.css :root/body */}
      <body>{children}</body>
    </html>
  );
}
