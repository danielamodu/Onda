"use client";

import { Brand } from "@/components/brand";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="not-found"><Brand/><p className="eyebrow">TEMPORARY ISSUE</p><h1>That didn’t load.</h1><p>Try again. Your saved payments remain unchanged.</p><button className="button button-primary" onClick={reset}>Try again <span>→</span></button></main>;
}
