import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { getBatchStatus } from "@/lib/payments/settlement/batches";

export async function GET(_request: Request, { params }: { params: Promise<{ batchId: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Sign in to view batch status." }, { status: 401 });
  const { batchId } = await params;
  const batch = await getBatchStatus(user.businessId, batchId);
  if (!batch) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  return NextResponse.json(batch);
}
