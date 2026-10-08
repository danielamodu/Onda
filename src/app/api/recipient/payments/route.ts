import { NextResponse } from "next/server";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";
import { getRecipientDashboard } from "@/lib/recipients/service";

export async function GET() {
  const account = await getRecipientSessionAccount();
  if (!account) return NextResponse.json({ error: "Sign in to view incoming payments." }, { status: 401 });
  return NextResponse.json(await getRecipientDashboard(account.id));
}
