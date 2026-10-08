import { NextResponse } from "next/server";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";
import { getRecipientProfile } from "@/lib/recipients/service";

export async function GET() {
  const account = await getRecipientSessionAccount();
  if (!account) return NextResponse.json({ error: "Sign in to view your recipient profile." }, { status: 401 });
  const profile = await getRecipientProfile(account.id);
  if (!profile) return NextResponse.json({ error: "Recipient profile not found." }, { status: 404 });
  return NextResponse.json(profile);
}
