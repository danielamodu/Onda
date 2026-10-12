import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { SettlementConflictError } from "@/lib/payments/settlement/service";
import { settleBatch } from "@/lib/payments/settlement/batches";
import { SettlementConfigurationError, getSettlementRuntime } from "@/lib/payments/settlement/providers";

const bodySchema = z.object({
  paymentIds: z.array(z.string().min(1).max(64)).min(2).max(25),
});

function toErrorResponse(error: unknown) {
  if (error instanceof SettlementConflictError) {
    const message = error.message;
    const status = message === "Payment not found." || message === "One or more payments were not found." ? 404 : 409;
    return NextResponse.json({ error: message }, { status });
  }
  if (error instanceof SettlementConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: "Provide two or more payment ids to settle as a batch." }, { status: 400 });
  }
  return NextResponse.json({ error: "Batch settlement could not be verified. Check again shortly." }, { status: 503 });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to settle payments." }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide two or more payment ids to settle as a batch." }, { status: 400 });
  }
  try {
    const runtime = getSettlementRuntime();
    if (!("batchGateway" in runtime.provider)) {
      throw new SettlementConfigurationError("Batch settlement requires the real Tempo provider.");
    }
    const result = await settleBatch(user.businessId, parsed.data.paymentIds, {
      provider: runtime.provider,
      verifier: runtime.verifier,
    });
    if (result.state === "settling") return NextResponse.json(result, { status: 202 });
    if (result.state === "failed") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
