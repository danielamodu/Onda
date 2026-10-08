import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { createPaymentSchema } from "@/lib/payments/domain";
import { createPayment } from "@/lib/payments/service";

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to create a payment." }, { status: 401 });
  const parsed = createPaymentSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Check the payment details and try again.", fields: parsed.error.flatten().fieldErrors }, { status: 400 });
  try {
    const payment = await createPayment(user.businessId, parsed.data);
    return NextResponse.json({ id: payment.id }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Payment couldn’t be saved. Please try again." }, { status: 500 });
  }
}
