import { z } from "zod";

/**
 * Owner sign-in email, trimmed and lower-cased so it matches however it was typed. Only Latin-letter (ASCII)
 * addresses are accepted: Arabic addresses need SMTPUTF8, which most mail providers do not offer.
 */
export const ownerEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, "Use at most 254 characters.")
  .pipe(z.email("Enter an email address in Latin letters, such as name@example.com."));

export const OWNER_PASSWORD_MIN_LENGTH = 10;
export const OWNER_PASSWORD_MAX_LENGTH = 128;

/** Characters as people count them (code points), not UTF-16 units: an emoji or an Arabic letter is one. */
const characterCount = (value: string): number => Array.from(value).length;

/**
 * Any password as typed, in Unicode NFKC form, so the same Arabic or accented password matches whichever keyboard
 * typed it. The raw length is capped first so normalisation itself stays cheap.
 */
const passwordInput = z
  .string()
  .max(OWNER_PASSWORD_MAX_LENGTH * 4, `Use at most ${String(OWNER_PASSWORD_MAX_LENGTH)} characters.`)
  .transform((value) => value.normalize("NFKC"));

/** Length is the only rule (NIST SP 800-63B); the upper bound keeps hashing cost bounded. */
export const ownerPasswordSchema = passwordInput
  .refine((value) => characterCount(value) >= OWNER_PASSWORD_MIN_LENGTH, `Use at least ${String(OWNER_PASSWORD_MIN_LENGTH)} characters.`)
  .refine((value) => characterCount(value) <= OWNER_PASSWORD_MAX_LENGTH, `Use at most ${String(OWNER_PASSWORD_MAX_LENGTH)} characters.`);

/** A password being checked rather than set: normalised the same way, without the length rule. */
const enteredPasswordSchema = passwordInput.refine((value) => value.length > 0, "Enter your password.");

/** An invite or password reset token: 32 random bytes in base64url (43 characters). */
export const linkTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "This link is incomplete. Open it again from the message.");

export const signupRequestSchema = z.object({ inviteToken: linkTokenSchema, email: ownerEmailSchema, password: ownerPasswordSchema });
/** Sign-in does not apply the password rules, so an account keeps working if the rules change. */
export const loginRequestSchema = z.object({ email: ownerEmailSchema, password: enteredPasswordSchema });
export const passwordChangeRequestSchema = z.object({
  currentPassword: enteredPasswordSchema,
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
