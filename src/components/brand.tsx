import Image from "next/image";
import Link from "next/link";

export function Brand({ compact = false }: { compact?: boolean }) {
  return <Link className={`brand${compact ? " brand-compact" : ""}`} href="/" aria-label="Onda home"><Image className="brand-logo" src="/brand/onda-logo.png" alt="" width={159} height={156} priority /></Link>;
}

export function BrandEmblem({ className = "" }: { className?: string }) {
  return <Image className={`brand-emblem ${className}`} src="/brand/onda-logo.png" alt="" width={159} height={156} />;
}
