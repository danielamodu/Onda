import { z } from "zod";

export const recipientRegisterSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(10, "Use at least 10 characters.").max(100),
});

export const recipientLoginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});

export const recipientPreferenceSchema = z.object({
  preference: z.enum(["KEEP_STABLECOIN", "CONVERT_TO_NGN"]),
});

export type RecipientPreference = z.infer<typeof recipientPreferenceSchema>["preference"];
