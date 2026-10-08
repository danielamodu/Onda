"use client";

import { useRouter } from "next/navigation";
import { Brand } from "@/components/brand";

export function RecipientPortalHeader({ name }: { name: string }) {
  const router = useRouter();
  async function signOut() {
    await fetch("/api/recipient/auth/logout", { method: "POST" });
    router.push("/recipient/login");
    router.refresh();
  }

  return <header className="site-header"><Brand/><nav aria-label="Recipient navigation"><span className="business-label">{name}</span><button className="nav-link" onClick={signOut}>Sign out</button></nav></header>;
}
