import { NextResponse } from "next/server";
import { getRecipientSessionAccount } from "@/lib/auth/recipient-session";
import { RecipientAccessError, RecipientPaymentUnavailableError, selectRecipientPreference } from "@/lib/recipients/service";
import { recipientPreferenceSchema } from "@/lib/recipients/validation";

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const account = await getRecipientSessionAccount();
  if (!account) return NextResponse.json({ error: "Sign in to update your payment preference." }, { status: 401 });
  const parsed = recipientPreferenceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose a valid way to receive this payment." }, { status: 400 });
  const { id } = await params;
  try {
    const result = await selectRecipientPreference(account.id, id, parsed.data.preference);
    return NextResponse.json({ ...result, message: parsed.data.preference === "CONVERT_TO_NGN"
      ? "Your NGN preference is saved. Conversion and bank payout have not started."
      : "Your USDC preference is saved. No funds moved." });
  } catch (error) {
    if (error instanceof RecipientAccessError) return NextResponse.json({ error: "Payment not found." }, { status: 404 });
    if (error instanceof RecipientPaymentUnavailableError) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: "Your preference could not be saved. Please try again." }, { status: 500 });
  }
}
