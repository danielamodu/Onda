import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link className={`brand${compact ? " brand-compact" : ""}`} href="/" aria-label="Onda home"><span className="brand-mark" aria-hidden="true">o</span><span>onda</span></Link>;
}
