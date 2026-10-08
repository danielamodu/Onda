import { compare } from "bcryptjs";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createRecipientSession } from "@/lib/auth/recipient-session";
import { recipientLoginSchema } from "@/lib/recipients/validation";

export async function POST(request: Request) {
  const parsed = recipientLoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email and password." }, { status: 400 });
  const account = await db.recipientAccount.findUnique({ where: { email: parsed.data.email } });
  if (!account || !(await compare(parsed.data.password, account.passwordHash))) return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  await createRecipientSession(account.id);
  return NextResponse.json({ ok: true });
}
