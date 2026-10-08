import Link from "next/link";
import { Brand } from "@/components/brand";
import { LogoutButton } from "@/components/logout-button";

export function SiteHeader({ signedIn = false, businessName }: { signedIn?: boolean; businessName?: string }) {
  return <header className="site-header"><Brand /><nav aria-label="Main navigation">{signedIn ? <><span className="business-label">{businessName}</span><LogoutButton /></> : <><Link className="nav-link" href="/login">Sign in</Link><Link className="button button-small" href="/signup">Create account</Link></>}</nav></header>;
}
