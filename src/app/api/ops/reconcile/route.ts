import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth/session";
import { reconcileStaleSettlements } from "@/lib/payments/settlement/reconcile";
import { getTempoFundingConfig } from "@/lib/payments/tempo/config";
import { SettlementConfigurationError, getSettlementRuntime } from "@/lib/payments/settlement/providers";

const bodySchema = z.object({
  olderThanMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to reconcile settlements." }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid reconciliation options." }, { status: 400 });
  try {
    const runtime = getSettlementRuntime();
    const { items } = await reconcileStaleSettlements(
      { businessId: user.businessId, olderThanMs: parsed.data.olderThanMs, limit: parsed.data.limit },
      { provider: runtime.provider, verifier: runtime.verifier, fundingConfig: getTempoFundingConfig() },
    );
    return NextResponse.json({ items });
  } catch (error) {
    if (error instanceof SettlementConfigurationError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json({ error: "Reconciliation is temporarily unavailable. Check again shortly." }, { status: 503 });
  }
}
