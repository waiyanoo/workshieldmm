import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  mfaCode: z.string().min(6).max(10).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export const mfaVerifySchema = z.object({
  code: z.string().min(6).max(10),
});

// The new password matches the registration policy. `currentPassword` is
// required even on an admin-issued temporary one: the holder was given it, and
// requiring it stops a hijacked session locking the real owner out.
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(8).max(200),
  })
  .strict();
