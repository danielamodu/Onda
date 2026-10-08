import { z } from "zod";

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  businessName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(10, "Use at least 10 characters.").max(100),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1),
});
