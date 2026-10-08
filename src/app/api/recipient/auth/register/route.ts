import { hash } from "bcryptjs";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { createRecipientSession } from "@/lib/auth/recipient-session";
import { recipientRegisterSchema } from "@/lib/recipients/validation";

export async function POST(request: Request) {
  const parsed = recipientRegisterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Check your details and try again.", fields: parsed.error.flatten().fieldErrors }, { status: 400 });
  const { name, email, password } = parsed.data;
  try {
    const passwordHash = await hash(password, 12);
    const account = await db.$transaction(async (tx) => {
      const created = await tx.recipientAccount.create({ data: { name, email, passwordHash } });
      await tx.recipient.updateMany({
        where: { identifier: { equals: email, mode: "insensitive" } },
        data: { accountId: created.id },
      });
      return created;
    });
    await createRecipientSession(account.id);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "A recipient account with this email already exists." }, { status: 409 });
    }
    return NextResponse.json({ error: "We couldn’t create your recipient account. Please try again." }, { status: 500 });
  }
}
