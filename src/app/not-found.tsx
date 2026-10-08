import Link from "next/link";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return <main className="not-found"><Brand/><p className="eyebrow">NOT FOUND</p><h1>We can’t find that payment.</h1><p>It may have been removed, or it may belong to another business.</p><Link className="button button-primary" href="/">Back to payments</Link></main>;
}
