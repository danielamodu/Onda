import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { getTempoFundingConfig } from "@/lib/payments/tempo/config";
import { FundingConflictError, fundPayment } from "@/lib/payments/funding";

const bodySchema = z.object({
  transactionHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  authorizationSignature: z.string().regex(/^0x(?:[a-fA-F0-9]{128}|[a-fA-F0-9]{130})$/),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to fund this payment." }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid Tempo transaction hash and wallet authorization signature." }, { status: 400 });

  const { id } = await params;
  try {
    const result = await fundPayment(user.businessId, id, parsed.data.transactionHash as `0x${string}`, parsed.data.authorizationSignature as `0x${string}`, {
      config: getTempoFundingConfig(),
    });
    if (result.state === "pending") return NextResponse.json(result, { status: 202 });
    if (result.state === "failed") return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof FundingConflictError) {
      const status = error.message === "Payment not found." ? 404 : 409;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ error: "Tempo verification is temporarily unavailable. Try checking again." }, { status: 503 });
  }
}
