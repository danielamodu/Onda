import { NextResponse } from "next/server";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";
import { getIncomingPayment } from "@/lib/recipients/service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const account = await getRecipientSessionAccount();
  if (!account) return NextResponse.json({ error: "Sign in to view this payment." }, { status: 401 });
  const { id } = await params;
  const payment = await getIncomingPayment(account.id, id);
  if (!payment) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
  return NextResponse.json(payment);
}
