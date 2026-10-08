import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Onda — Business payments, made clear",
  description: "Create and track cross-border payments to Nigeria.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
