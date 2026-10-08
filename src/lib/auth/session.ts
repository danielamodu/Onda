import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";

const cookieName = "onda_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  await db.authSession.create({ data: { userId, tokenHash: hash(token), expiresAt } });
  (await cookies()).set(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSessionUser() {
  const token = (await cookies()).get(cookieName)?.value;
  if (!token) return null;
  const session = await db.authSession.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: { select: { id: true, name: true, email: true, businessId: true, business: true } } },
  });
  if (!session || session.expiresAt <= new Date()) return null;
  return session.user;
}

export async function deleteSession() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  if (token) await db.authSession.deleteMany({ where: { tokenHash: hash(token) } });
  jar.delete(cookieName);
}
