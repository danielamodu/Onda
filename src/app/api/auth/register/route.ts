import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { registerSchema } from "@/lib/auth/validation";

export async function POST(request: Request) {
  const parsed = registerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Check the details and try again.", fields: parsed.error.flatten().fieldErrors }, { status: 400 });
  const { name, businessName, email, password } = parsed.data;
  if (await db.user.findUnique({ where: { email } })) return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  try {
    const passwordHash = await hash(password, 12);
    const user = await db.$transaction(async (tx) => {
      const business = await tx.business.create({ data: { name: businessName, email } });
      return tx.user.create({ data: { name, email, passwordHash, businessId: business.id } });
    });
    await createSession(user.id);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }
    return NextResponse.json({ error: "We couldn’t create your account. Please try again." }, { status: 500 });
  }
}
