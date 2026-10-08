"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }
  return <button className="nav-link" onClick={logout} disabled={busy}>{busy ? "Signing out…" : "Sign out"}</button>;
}
