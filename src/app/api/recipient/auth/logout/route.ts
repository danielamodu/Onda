import { NextResponse } from "next/server";
import { deleteRecipientSession } from "@/lib/auth/recipient-session";

export async function POST() {
  await deleteRecipientSession();
  return NextResponse.json({ ok: true });
}
