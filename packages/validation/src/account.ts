import { z } from 'zod';
import { MemberRole } from '@smartchat/types';
import {
  displayNameSchema,
  emailSchema,
  localeSchema,
  timezoneSchema,
  uuidSchema,
} from './common.js';

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timezone: timezoneSchema.optional(),
  locale: localeSchema.optional(),
  dataRetentionDays: z.number().int().min(7).max(3650).nullable().optional(),
});

const memberRoleSchema = z.enum([
  MemberRole.OWNER,
  MemberRole.ADMIN,
  MemberRole.MANAGER,
  MemberRole.AGENT,
]);

export const inviteMemberSchema = z.object({
  email: emailSchema,
  name: displayNameSchema.optional(),
  baseRole: memberRoleSchema.default(MemberRole.AGENT),
  /** An optional custom role layered on top of the base role's defaults. */
  roleId: uuidSchema.optional(),
  title: z.string().trim().max(120).optional(),
  /** When true the member sees only the websites listed below. */
  restrictedToProperties: z.boolean().default(false),
  propertyIds: z.array(uuidSchema).max(200).optional(),
  departmentIds: z.array(uuidSchema).max(50).optional(),
});

export const updateMemberSchema = z.object({
  baseRole: memberRoleSchema.optional(),
  roleId: uuidSchema.nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  title: z.string().trim().max(120).nullable().optional(),
  displayName: displayNameSchema.nullable().optional(),
  restrictedToProperties: z.boolean().optional(),
  propertyIds: z.array(uuidSchema).max(200).optional(),
  departmentIds: z.array(uuidSchema).max(50).optional(),
});

export const availabilitySchema = z.object({
  availability: z.enum(['online', 'away', 'offline']),
});

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(60),
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores'),
  description: z.string().trim().max(280).optional(),
  permissions: z.array(z.string().min(3).max(60)).max(200),
});

export const updateRoleSchema = createRoleSchema.partial().omit({ key: true });

export const createDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(60),
  key: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores'),
  description: z.string().trim().max(280).optional(),
  isDefault: z.boolean().default(false),
});

export const updateDepartmentSchema = createDepartmentSchema.partial().omit({ key: true });

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type AvailabilityInput = z.infer<typeof availabilitySchema>;
export type CreateRoleInput = z.infer<typeof createRoleSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
