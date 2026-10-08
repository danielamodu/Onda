import { compare } from "bcryptjs";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { loginSchema } from "@/lib/auth/validation";

export async function POST(request: Request) {
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a valid email and password." }, { status: 400 });
  const user = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || !(await compare(parsed.data.password, user.passwordHash))) return NextResponse.json({ error: "Email or password is incorrect." }, { status: 401 });
  await createSession(user.id);
  return NextResponse.json({ ok: true });
}
