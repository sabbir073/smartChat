import { z } from 'zod';
import { emailSchema, uuidSchema } from './common.js';

/**
 * Billing, from both sides: what an account can ask for, and what the operator can configure.
 */

export const billingIntervalSchema = z.enum(['month', 'year']);

export const planKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Use lowercase letters, numbers, hyphens and underscores');

/** Start buying a plan. */
export const checkoutSchema = z.object({
  planKey: planKeySchema,
  interval: billingIntervalSchema.default('month'),
});

/** "I need something bigger." */
export const billingEnquirySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  message: z.string().trim().min(10).max(4000),
  wants: z
    .object({
      websites: z.number().int().min(1).max(100_000).optional(),
      teamMembers: z.number().int().min(1).max(100_000).optional(),
      aiAgent: z.boolean().optional(),
    })
    .default({}),
});

// --- operator side ----------------------------------------------------------

/** Whole cents, never fractional; a plan priced at $20 is 2000. Zero means "not sold this way". */
const priceCentsSchema = z.number().int().min(0).max(100_000_000);

/** A limit; null is unlimited. */
const limitSchema = z.number().int().min(1).max(1_000_000).nullable();

export const createPlanSchema = z.object({
  key: planKeySchema,
  name: z.string().trim().min(1).max(60),
  tagline: z.string().trim().max(120).nullable().default(null),
  description: z.string().trim().max(600).nullable().default(null),
  monthlyPriceCents: priceCentsSchema.default(0),
  annualPriceCents: priceCentsSchema.default(0),
  currency: z
    .string()
    .trim()
    .toLowerCase()
    .length(3)
    .regex(/^[a-z]{3}$/, 'A three-letter currency code, like usd')
    .default('usd'),
  maxProperties: limitSchema.default(1),
  maxMembers: limitSchema.default(1),
  aiAgent: z.boolean().default(false),
  integrations: z.boolean().default(false),
  removeBranding: z.boolean().default(false),
  isContactSales: z.boolean().default(false),
  isPublic: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export const updatePlanSchema = createPlanSchema
  .partial()
  .omit({ key: true })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');

const secretInput = z.string().trim().min(8).max(500);

/**
 * The operator's billing settings. A secret that is omitted is left as it is; `null` clears it.
 * That is what lets the console save the grace window without re-typing the Stripe key.
 */
export const updateBillingSettingsSchema = z
  .object({
    stripePublishableKey: z
      .string()
      .trim()
      .regex(/^pk_(test|live)_[A-Za-z0-9]+$/, 'A Stripe publishable key starts with pk_test_ or pk_live_')
      .nullable()
      .optional(),
    stripeSecretKey: secretInput
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, 'A Stripe secret key starts with sk_test_ or sk_live_')
      .nullable()
      .optional(),
    stripeWebhookSecret: secretInput
      .regex(/^whsec_[A-Za-z0-9]+$/, 'A Stripe webhook signing secret starts with whsec_')
      .nullable()
      .optional(),
    graceDays: z.number().int().min(0).max(60).optional(),
    contactEmail: emailSchema.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');

/** Put an account on a plan by hand: a sponsored account, a bespoke deal, a support gesture. */
export const setAccountPlanSchema = z.object({
  planKey: planKeySchema,
  note: z.string().trim().max(300).nullable().default(null),
});

export const enquiryIdParamSchema = z.object({ id: uuidSchema });

export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type BillingEnquiryInput = z.infer<typeof billingEnquirySchema>;
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type UpdateBillingSettingsInput = z.infer<typeof updateBillingSettingsSchema>;
export type SetAccountPlanInput = z.infer<typeof setAccountPlanSchema>;
