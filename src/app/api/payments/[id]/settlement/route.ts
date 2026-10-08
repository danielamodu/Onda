import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { SettlementConflictError, settlePayment } from "@/lib/payments/settlement/service";
import { SettlementConfigurationError, getSettlementRuntime } from "@/lib/payments/settlement/providers";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to settle this payment." }, { status: 401 });
  const { id } = await params;
  try {
    const runtime = getSettlementRuntime();
    const result = await settlePayment(user.businessId, id, runtime);
    if (result.state === "settling") return NextResponse.json(result, { status: 202 });
    if (result.state === "failed") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SettlementConflictError) {
      const status = error.message === "Payment not found." ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof SettlementConfigurationError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "Settlement could not be verified. Check again shortly." }, { status: 503 });
  }
}
