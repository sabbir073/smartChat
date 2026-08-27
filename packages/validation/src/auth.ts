import { z } from 'zod';
import {
  displayNameSchema,
  emailSchema,
  localeSchema,
  timezoneSchema,
  uuidSchema,
} from './common.js';
import { passwordIsDerivedFrom, passwordSchema } from './password.js';

export const registerSchema = z
  .object({
    name: displayNameSchema,
    email: emailSchema,
    password: passwordSchema,
    accountName: z.string().trim().min(1, 'Enter your company or team name').max(120),
    timezone: timezoneSchema.default('UTC'),
    locale: localeSchema.default('en'),
    acceptTerms: z.literal(true, {
      errorMap: () => ({ message: 'You must accept the terms to continue' }),
    }),
  })
  .superRefine((value, ctx) => {
    if (passwordIsDerivedFrom(value.password, value.email, value.name, value.accountName)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Your password must not contain your name, email or company name',
      });
    }
  });

export const loginSchema = z.object({
  email: emailSchema,
  // Deliberately only length-bounded: an existing password must never be rejected by a policy
  // that changed after it was set.
  password: z.string().min(1, 'Enter your password').max(256),
  remember: z.boolean().default(true),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z
  .object({
    token: z.string().min(20).max(200),
    password: passwordSchema,
  })
  .superRefine((value, ctx) => {
    if (passwordIsDerivedFrom(value.password, 'smartchat')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'That password is too easy to guess',
      });
    }
  });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

export const resendVerificationSchema = z.object({
  email: emailSchema,
});

/**
 * Accepting an invitation.
 *
 * Name and password are optional because two different people arrive here: somebody who already
 * has a SmartChat login and only needs the membership activated, and somebody brand new who has
 * to choose a password. Which one it is depends on the invited address, which the server knows
 * and the client does not - so the requirement is enforced there rather than guessed here.
 */
export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  name: displayNameSchema.optional(),
  password: passwordSchema.optional(),
});

export const updateProfileSchema = z.object({
  name: displayNameSchema.optional(),
  timezone: timezoneSchema.optional(),
  locale: localeSchema.optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

export const revokeSessionSchema = z.object({
  id: uuidSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
