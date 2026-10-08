import { z } from "zod";

/** Owner sign-in email, trimmed and lower-cased so it matches however it was typed. */
export const ownerEmailSchema = z.string().trim().toLowerCase().max(254, "Use at most 254 characters.").pipe(z.email("Enter a valid email address."));

export const OWNER_PASSWORD_MIN_LENGTH = 10;
export const OWNER_PASSWORD_MAX_LENGTH = 128;

/** Length is the only rule (NIST SP 800-63B); the upper bound keeps hashing cost bounded. */
export const ownerPasswordSchema = z
  .string()
  .min(OWNER_PASSWORD_MIN_LENGTH, `Use at least ${String(OWNER_PASSWORD_MIN_LENGTH)} characters.`)
  .max(OWNER_PASSWORD_MAX_LENGTH, `Use at most ${String(OWNER_PASSWORD_MAX_LENGTH)} characters.`);

/** An invite or password reset token: 32 random bytes in base64url (43 characters). */
export const linkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is incomplete. Open it again from the message.");

export const signupRequestSchema = z.object({ inviteToken: linkTokenSchema, email: ownerEmailSchema, password: ownerPasswordSchema });
/** Sign-in does not apply the password rules, so an account keeps working if the rules change. */
export const loginRequestSchema = z.object({ email: ownerEmailSchema, password: z.string().min(1).max(OWNER_PASSWORD_MAX_LENGTH) });
export const passwordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(OWNER_PASSWORD_MAX_LENGTH),
  newPassword: ownerPasswordSchema,
});
export const passwordResetRequestSchema = z.object({ email: ownerEmailSchema });
export const passwordResetCompleteRequestSchema = z.object({ token: linkTokenSchema, password: ownerPasswordSchema });

/** The signed-in owner and their café, returned by signup, sign-in and the session check. */
export const ownerSessionSchema = z.object({
  owner: z.object({ id: z.uuid(), email: z.string() }),
  cafe: z.object({ id: z.uuid(), name: z.string() }),
});

export type SignupRequest = z.input<typeof signupRequestSchema>;
export type LoginRequest = z.input<typeof loginRequestSchema>;
export type PasswordChangeRequest = z.input<typeof passwordChangeRequestSchema>;
export type PasswordResetRequest = z.input<typeof passwordResetRequestSchema>;
export type PasswordResetCompleteRequest = z.input<typeof passwordResetCompleteRequestSchema>;
export type OwnerSession = z.output<typeof ownerSessionSchema>;
