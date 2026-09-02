import type { Account, AccountMember, Database, Department, Role, User } from '@smartchat/database';
import {
  ActorType as DbActorType,
  MemberStatus,
  TokenPurpose,
  isUniqueViolation,
} from '@smartchat/database';
import {
  ALL_PERMISSIONS,
  AppError,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorCode,
  FeatureKey,
  Permission,
  type MemberRole,
  type TenantContext,
} from '@smartchat/types';
import type {
  AcceptInvitationInput,
  CreateDepartmentInput,
  CreateRoleInput,
  InviteMemberInput,
  UpdateDepartmentInput,
  UpdateMemberInput,
  UpdateRoleInput,
} from '@smartchat/validation';
import { generateToken, hashToken } from '../crypto/tokens.js';
import { hashPassword } from '../crypto/password.js';
import type { MailProvider } from '../mail/provider.js';
import type { BrandContext } from '../mail/templates.js';
import { invitationTemplate } from '../mail/templates.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import { TokenRepository } from '../repositories/token.repository.js';
import { UserRepository } from '../repositories/user.repository.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';
import type { PlanGuard } from './plan-guard.js';

const DAY = 86_400_000;

export interface TeamServiceOptions {
  db: Database;
  /** Required, not optional: an entitlement nobody is forced to wire up is one nobody wires up. */
  plan: PlanGuard;
  mailer: MailProvider;
  brand: BrandContext;
  /** Hand the invitation email to the queue when there is one; otherwise send inline. */
  deliver?: (message: Parameters<MailProvider['send']>[0]) => Promise<void>;
  clock?: Clock;
  invitationTtlMs?: number;
}

export interface InvitationView {
  id: string;
  email: string;
  baseRole: string;
  createdAt: string;
  expiresAt: string;
  invitedByName: string | null;
}

/**
 * Everything about who is on a team and what they can reach.
 *
 * The rules that matter here are the ones that stop an account locking itself out or leaking
 * across a tenant boundary: the last owner cannot be demoted or removed, and every property,
 * department and role id supplied by a client is checked against *this* account before it is
 * written to a row.
 */
export class TeamService {
  private readonly repo: AccountRepository;
  private readonly audit: AuditRepository;
  private readonly clock: Clock;
  private readonly invitationTtlMs: number;

  constructor(private readonly options: TeamServiceOptions) {
    this.repo = new AccountRepository(options.db);
    this.audit = new AuditRepository(options.db);
    this.clock = options.clock ?? systemClock;
    this.invitationTtlMs = options.invitationTtlMs ?? 7 * DAY;
  }

  // --- members --------------------------------------------------------------

  async listMembers(context: TenantContext) {
    requirePermission(context, Permission.MEMBER_VIEW);
    return this.repo.listMembers(context);
  }

  async getMember(context: TenantContext, memberId: string) {
    requirePermission(context, Permission.MEMBER_VIEW);
    const member = await this.repo.findMemberById(context, memberId);
    if (!member) throw new AppError(ErrorCode.MEMBER_NOT_FOUND);
    return member;
  }

  /**
   * Invite somebody to the account.
   *
   * The membership row is created immediately with `invited` status, so the team list shows the
   * person as pending rather than the invitation living only inside an email nobody can see. The
   * token is the only thing that turns it into access.
   */
  async invite(
    context: TenantContext,
    input: InviteMemberInput,
    inviterName: string,
  ): Promise<{ member: AccountMember; alreadyMember: boolean }> {
    requirePermission(context, Permission.MEMBER_INVITE);
    this.assertCanGrantRole(context, input.baseRole);
    // Counted before the invitation is sent, not when it is accepted: an invitation that cannot
    // be accepted is worse than one that was never sent.
    await this.options.plan.assertCanAdd(context, FeatureKey.MAX_AGENTS);

    const email = input.email.trim().toLowerCase();
    const now = this.clock.now();

    const existingMember = await this.repo.findMemberByEmail(context.accountId, email);
    if (existingMember) {
      // Re-inviting somebody who is already here is not an error worth a stack trace, but it must
      // not silently look like a fresh invitation either.
      throw new AppError(ErrorCode.MEMBER_ALREADY_EXISTS, 'That person is already on this team');
    }

    const users = new UserRepository(this.options.db);
    const existingUser = await users.findByEmail(email);

    const propertyIds = await this.resolvePropertyIds(context.accountId, input.propertyIds ?? []);
    const departmentIds = await this.resolveDepartmentIds(
      context.accountId,
      input.departmentIds ?? [],
    );
    const roleId = await this.resolveRoleId(context.accountId, input.roleId);

    const member = await this.options.db.$transaction(async (tx) => {
      const accounts = new AccountRepository(tx);

      // A user row is created up front only when there is none: an invitation to an address that
      // has never registered still has to be attachable to a membership.
      const userId =
        existingUser?.id ??
        (
          await new UserRepository(tx).create({
            email,
            passwordHash: null,
            name: email.split('@')[0] ?? email,
            timezone: 'UTC',
            locale: 'en',
            emailVerifiedAt: null,
          })
        ).id;

      const created = await accounts.createMember({
        accountId: context.accountId,
        userId,
        baseRole: input.baseRole,
        status: 'invited',
        invitedByUserId: context.userId ?? null,
        invitedAt: now,
        joinedAt: null,
        title: input.title ?? null,
        restrictedToProperties: input.restrictedToProperties ?? false,
      });

      if (roleId) {
        await accounts.updateMember(context, created.id, { roleId });
      }
      await accounts.setMemberProperties(context.accountId, created.id, propertyIds);
      await accounts.setMemberDepartments(context.accountId, created.id, departmentIds);

      return created;
    });

    await this.sendInvitation(context.accountId, email, inviterName, now);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'member.invited',
      resourceType: 'member',
      resourceId: member.id,
      ip: context.ip ?? null,
      metadata: { email, baseRole: input.baseRole, restricted: input.restrictedToProperties },
    });

    return { member, alreadyMember: false };
  }

  /** Issue (or re-issue) the invitation token and email it. */
  private async sendInvitation(
    accountId: string,
    email: string,
    inviterName: string,
    now: Date,
  ): Promise<void> {
    const tokens = new TokenRepository(this.options.db);
    // A re-send must retire the previous link, so an old email left in an inbox stops working.
    await tokens.invalidateOutstanding(email, TokenPurpose.member_invitation, now);

    const raw = generateToken();
    const expiresAt = new Date(now.getTime() + this.invitationTtlMs);
    await tokens.create({
      purpose: TokenPurpose.member_invitation,
      tokenHash: hashToken(raw),
      email,
      accountId,
      expiresAt,
    });

    const account = await this.options.db.account.findUnique({ where: { id: accountId } });

    const message = invitationTemplate(this.options.brand, {
      email,
      inviterName,
      accountName: account?.name ?? this.options.brand.productName,
      url: `${this.options.brand.appUrl}/accept-invitation?token=${encodeURIComponent(raw)}`,
      expiresInDays: Math.round(this.invitationTtlMs / DAY),
    });

    if (this.options.deliver) await this.options.deliver(message);
    else await this.options.mailer.send(message);
  }

  async listInvitations(context: TenantContext): Promise<InvitationView[]> {
    requirePermission(context, Permission.MEMBER_VIEW);
    const now = this.clock.now();

    const pending = await this.options.db.accountMember.findMany({
      where: { accountId: context.accountId, deletedAt: null, status: MemberStatus.invited },
      include: {
        user: { select: { email: true } },
        invitedBy: { select: { name: true } },
      },
      orderBy: { invitedAt: 'desc' },
      take: 200,
    });

    const tokens = await this.options.db.verificationToken.findMany({
      where: {
        accountId: context.accountId,
        purpose: TokenPurpose.member_invitation,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      select: { email: true, expiresAt: true },
    });
    const expiryByEmail = new Map(tokens.map((token) => [token.email, token.expiresAt]));

    return pending.map((member) => ({
      id: member.id,
      email: member.user.email,
      baseRole: member.baseRole,
      createdAt: (member.invitedAt ?? member.createdAt).toISOString(),
      // No live token means the link has lapsed. Reported rather than hidden, so somebody can
      // resend instead of wondering why nothing arrived.
      expiresAt: expiryByEmail.get(member.user.email)?.toISOString() ?? '',
      invitedByName: member.invitedBy?.name ?? null,
    }));
  }

  async resendInvitation(
    context: TenantContext,
    memberId: string,
    inviterName: string,
  ): Promise<void> {
    requirePermission(context, Permission.MEMBER_INVITE);
    const member = await this.getMember(context, memberId);
    if (member.status !== MemberStatus.invited) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That person has already joined');
    }
    await this.sendInvitation(context.accountId, member.user.email, inviterName, this.clock.now());
  }

  async revokeInvitation(context: TenantContext, memberId: string): Promise<void> {
    requirePermission(context, Permission.MEMBER_INVITE);
    const member = await this.getMember(context, memberId);
    if (member.status !== MemberStatus.invited) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That person has already joined');
    }

    const now = this.clock.now();
    await new TokenRepository(this.options.db).invalidateOutstanding(
      member.user.email,
      TokenPurpose.member_invitation,
      now,
    );
    await this.repo.updateMember(context, memberId, { deletedAt: now });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'member.invitation_revoked',
      resourceType: 'member',
      resourceId: memberId,
      ip: context.ip ?? null,
      metadata: { email: member.user.email },
    });
  }

  /**
   * Accept an invitation.
   *
   * Two paths meet here: somebody who already has a SmartChat login, and somebody who does not.
   * The second needs a password, and the invitation itself proves the address, so the account is
   * created already verified - a second confirmation email would be asking them to prove
   * something they have just proved.
   */
  async acceptInvitation(
    input: AcceptInvitationInput,
  ): Promise<{ user: User; accountId: string; created: boolean }> {
    const tokens = new TokenRepository(this.options.db);
    const now = this.clock.now();

    const record = await tokens.findUsable(
      hashToken(input.token),
      TokenPurpose.member_invitation,
      now,
    );
    if (!record?.accountId) throw new AppError(ErrorCode.INVALID_TOKEN);

    const users = new UserRepository(this.options.db);
    const user = await users.findByEmail(record.email);
    // The membership row was created with the invitation; without it the invitation is stale.
    const member = user
      ? await this.options.db.accountMember.findFirst({
          where: { accountId: record.accountId, userId: user.id, deletedAt: null },
        })
      : null;
    if (!user || !member) throw new AppError(ErrorCode.INVALID_TOKEN);

    const needsPassword = user.passwordHash === null;
    if (needsPassword && !input.password) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Choose a password to finish setting up');
    }

    if (!(await tokens.consume(record.id, now))) throw new AppError(ErrorCode.INVALID_TOKEN);

    await this.options.db.$transaction(async (tx) => {
      if (needsPassword) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            passwordHash: await hashPassword(input.password as string),
            ...(input.name ? { name: input.name } : {}),
            emailVerifiedAt: user.emailVerifiedAt ?? now,
          },
        });
      }
      await tx.accountMember.updateMany({
        where: { id: member.id },
        data: { status: MemberStatus.active, joinedAt: member.joinedAt ?? now },
      });
    });

    await this.audit.record({
      accountId: record.accountId,
      actorType: DbActorType.user,
      actorId: user.id,
      action: 'member.joined',
      resourceType: 'member',
      resourceId: member.id,
      metadata: { email: record.email },
    });

    const refreshed = await users.findByEmail(record.email);
    return { user: refreshed ?? user, accountId: record.accountId, created: needsPassword };
  }

  async updateMember(context: TenantContext, memberId: string, input: UpdateMemberInput) {
    requirePermission(context, Permission.MEMBER_UPDATE);
    const member = await this.getMember(context, memberId);

    if (input.baseRole !== undefined && input.baseRole !== member.baseRole) {
      this.assertCanGrantRole(context, input.baseRole);
      if (member.baseRole === 'owner') await this.assertNotLastOwner(context, memberId);
    }
    if (input.status !== undefined && input.status !== 'active' && member.baseRole === 'owner') {
      await this.assertNotLastOwner(context, memberId);
    }

    const data: Record<string, unknown> = {};
    if (input.baseRole !== undefined) data['baseRole'] = input.baseRole;
    if (input.title !== undefined) data['title'] = input.title;
    if (input.displayName !== undefined) data['displayName'] = input.displayName;
    if (input.status !== undefined) data['status'] = input.status;
    if (input.restrictedToProperties !== undefined) {
      data['restrictedToProperties'] = input.restrictedToProperties;
    }
    if (input.roleId !== undefined) {
      data['roleId'] =
        input.roleId === null ? null : await this.resolveRoleId(context.accountId, input.roleId);
    }

    if (Object.keys(data).length > 0) {
      await this.repo.updateMember(context, memberId, data);
    }
    if (input.propertyIds !== undefined) {
      const ids = await this.resolvePropertyIds(context.accountId, input.propertyIds);
      await this.repo.setMemberProperties(context.accountId, memberId, ids);
    }
    if (input.departmentIds !== undefined) {
      const ids = await this.resolveDepartmentIds(context.accountId, input.departmentIds);
      await this.repo.setMemberDepartments(context.accountId, memberId, ids);
    }

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'member.updated',
      resourceType: 'member',
      resourceId: memberId,
      ip: context.ip ?? null,
      metadata: { ...input },
    });

    return this.getMember(context, memberId);
  }

  async removeMember(context: TenantContext, memberId: string): Promise<void> {
    requirePermission(context, Permission.MEMBER_REMOVE);
    const member = await this.getMember(context, memberId);

    if (member.baseRole === 'owner') await this.assertNotLastOwner(context, memberId);
    if (context.memberId === memberId) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'You cannot remove yourself');
    }

    const now = this.clock.now();
    await this.repo.updateMember(context, memberId, {
      deletedAt: now,
      status: MemberStatus.disabled,
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'member.removed',
      resourceType: 'member',
      resourceId: memberId,
      ip: context.ip ?? null,
      metadata: { email: member.user.email },
    });
  }

  /**
   * The caller's own availability.
   *
   * Not permission-gated in either direction: an agent asking about themselves is not asking
   * about the team, and MEMBER_VIEW is a permission most agents do not have.
   */
  async getAvailability(context: TenantContext): Promise<'online' | 'away' | 'offline'> {
    if (!context.memberId) return 'offline';
    const member = await this.options.db.accountMember.findFirst({
      where: { id: context.memberId, accountId: context.accountId },
      select: { availability: true },
    });
    return (member?.availability ?? 'offline') as 'online' | 'away' | 'offline';
  }

  /** The agent's own availability. Not a permission-gated action: it is about themselves. */
  async setAvailability(
    context: TenantContext,
    availability: 'online' | 'away' | 'offline',
  ): Promise<void> {
    if (!context.memberId) throw new AppError(ErrorCode.FORBIDDEN);
    await this.repo.updateMember(context, context.memberId, { availability });
  }

  // --- roles ----------------------------------------------------------------

  async listRoles(context: TenantContext): Promise<Role[]> {
    requirePermission(context, Permission.MEMBER_VIEW);
    return this.options.db.role.findMany({
      where: { accountId: context.accountId },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
  }

  async createRole(context: TenantContext, input: CreateRoleInput): Promise<Role> {
    requirePermission(context, Permission.ROLE_MANAGE);
    // The four preset roles are always available; only defining your own is a paid capability.
    await this.options.plan.assertFeature(context, FeatureKey.FEATURE_CUSTOM_ROLES);
    try {
      const role = await this.options.db.role.create({
        data: {
          accountId: context.accountId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          permissions: this.sanitisePermissions(context, input.permissions),
          isSystem: false,
        },
      });

      /**
       * Audited, because a role *is* a set of permissions.
       *
       * These three methods wrote no audit row for the whole of the product's life, while the
       * methods either side of them did, and `SECURITY.md` said role edits were logged. Editing a
       * custom role's permission list is the primary way somebody inside an account escalates
       * their own privileges - it is the last thing that should happen without a trace.
       */
      await this.audit.record({
        accountId: context.accountId,
        actorType: DbActorType.user,
        actorId: context.userId ?? null,
        action: AuditAction.ROLE_CREATED,
        resourceType: 'role',
        resourceId: role.id,
        ip: context.ip ?? null,
        metadata: { key: role.key, name: role.name, permissions: role.permissions },
      });

      return role;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A role with that key already exists');
      }
      throw error;
    }
  }

  async updateRole(context: TenantContext, roleId: string, input: UpdateRoleInput): Promise<Role> {
    requirePermission(context, Permission.ROLE_MANAGE);
    const role = await this.options.db.role.findFirst({
      where: { id: roleId, accountId: context.accountId },
    });
    if (!role) throw new AppError(ErrorCode.NOT_FOUND);

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.description !== undefined) data['description'] = input.description;
    if (input.permissions !== undefined) {
      data['permissions'] = this.sanitisePermissions(context, input.permissions);
    }

    await this.options.db.role.updateMany({
      where: { id: roleId, accountId: context.accountId },
      data,
    });
    const updated = await this.options.db.role.findFirst({
      where: { id: roleId, accountId: context.accountId },
    });
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND);

    // Both lists, because "what changed" is the question the log is read to answer.
    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.ROLE_UPDATED,
      resourceType: 'role',
      resourceId: updated.id,
      ip: context.ip ?? null,
      metadata: {
        key: updated.key,
        name: updated.name,
        permissionsBefore: role.permissions,
        permissionsAfter: updated.permissions,
      },
    });

    return updated;
  }

  async deleteRole(context: TenantContext, roleId: string): Promise<void> {
    requirePermission(context, Permission.ROLE_MANAGE);
    const role = await this.options.db.role.findFirst({
      where: { id: roleId, accountId: context.accountId },
    });
    if (!role) throw new AppError(ErrorCode.NOT_FOUND);
    // System roles ship with the product and other things assume they exist.
    if (role.isSystem) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Built-in roles cannot be deleted');
    }
    // Members keep their base role; only the custom overlay goes away.
    await this.options.db.accountMember.updateMany({
      where: { accountId: context.accountId, roleId },
      data: { roleId: null },
    });
    await this.options.db.role.deleteMany({ where: { id: roleId, accountId: context.accountId } });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.ROLE_DELETED,
      resourceType: 'role',
      resourceId: roleId,
      ip: context.ip ?? null,
      metadata: { key: role.key, name: role.name, permissions: role.permissions },
    });
  }

  // --- departments ----------------------------------------------------------

  async listDepartments(context: TenantContext): Promise<Department[]> {
    requirePermission(context, Permission.MEMBER_VIEW);
    return this.options.db.department.findMany({
      where: { accountId: context.accountId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  }

  async createDepartment(
    context: TenantContext,
    input: CreateDepartmentInput,
  ): Promise<Department> {
    requirePermission(context, Permission.MEMBER_UPDATE);
    try {
      const created = await this.options.db.department.create({
        data: {
          accountId: context.accountId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          isDefault: input.isDefault ?? false,
        },
      });
      if (created.isDefault) await this.clearOtherDefaults(context.accountId, created.id);
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'A department with that key already exists',
        );
      }
      throw error;
    }
  }

  async updateDepartment(
    context: TenantContext,
    departmentId: string,
    input: UpdateDepartmentInput,
  ): Promise<Department> {
    requirePermission(context, Permission.MEMBER_UPDATE);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.description !== undefined) data['description'] = input.description;
    if (input.isDefault !== undefined) data['isDefault'] = input.isDefault;

    const result = await this.options.db.department.updateMany({
      where: { id: departmentId, accountId: context.accountId, deletedAt: null },
      data,
    });
    if (result.count === 0) throw new AppError(ErrorCode.NOT_FOUND);
    if (input.isDefault) await this.clearOtherDefaults(context.accountId, departmentId);

    const updated = await this.options.db.department.findFirst({
      where: { id: departmentId, accountId: context.accountId },
    });
    if (!updated) throw new AppError(ErrorCode.NOT_FOUND);
    return updated;
  }

  async deleteDepartment(context: TenantContext, departmentId: string): Promise<void> {
    requirePermission(context, Permission.MEMBER_UPDATE);
    const now = this.clock.now();
    const result = await this.options.db.department.updateMany({
      where: { id: departmentId, accountId: context.accountId, deletedAt: null },
      data: { deletedAt: now, isDefault: false },
    });
    if (result.count === 0) throw new AppError(ErrorCode.NOT_FOUND);
    // Conversations keep their history; they simply stop belonging to a desk that no longer exists.
    await this.options.db.conversation.updateMany({
      where: { accountId: context.accountId, departmentId },
      data: { departmentId: null },
    });
    await this.options.db.departmentMember.deleteMany({
      where: { accountId: context.accountId, departmentId },
    });
  }

  private async clearOtherDefaults(accountId: string, keepId: string): Promise<void> {
    await this.options.db.department.updateMany({
      where: { accountId, isDefault: true, id: { not: keepId } },
      data: { isDefault: false },
    });
  }

  // --- guards ---------------------------------------------------------------

  /**
   * Nobody may hand out access they do not have.
   *
   * Without this an admin could promote somebody to owner and then act through them - a privilege
   * escalation that leaves no trace of having been one.
   */
  private assertCanGrantRole(context: TenantContext, role: MemberRole): void {
    if (role === 'owner' && context.role !== 'owner') {
      throw new AppError(ErrorCode.FORBIDDEN, 'Only an owner can make somebody else an owner');
    }
  }

  private async assertNotLastOwner(context: TenantContext, memberId: string): Promise<void> {
    const owners = await this.repo.countOwners(context.accountId);
    if (owners <= 1) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'An account must always have at least one owner',
      );
    }
    void memberId;
  }

  /** Silently dropping an unknown permission is safer than storing a string nothing enforces. */
  private sanitisePermissions(context: TenantContext, permissions: string[]): string[] {
    const valid = new Set<string>(ALL_PERMISSIONS as readonly string[]);
    const unknown = permissions.filter((entry) => !valid.has(entry));
    if (unknown.length > 0) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `Unknown permission: ${unknown[0] as string}`,
      );
    }
    // An owner may grant anything; anyone else may only grant what they themselves hold.
    if (context.role === 'owner') return permissions;
    const beyond = permissions.filter((entry) => !context.permissions.has(entry as Permission));
    if (beyond.length > 0) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'You cannot grant a permission you do not have yourself',
      );
    }
    return permissions;
  }

  /** Ids from a client are checked against this account before they reach a row. */
  private async resolvePropertyIds(accountId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.repo.existingPropertyIds(accountId, ids);
    if (found.length !== ids.length) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'One of those websites does not exist');
    }
    return found;
  }

  private async resolveDepartmentIds(accountId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.repo.existingDepartmentIds(accountId, ids);
    if (found.length !== ids.length) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'One of those departments does not exist');
    }
    return found;
  }

  private async resolveRoleId(
    accountId: string,
    roleId: string | null | undefined,
  ): Promise<string | null> {
    if (!roleId) return null;
    const role = await this.options.db.role.findFirst({ where: { id: roleId, accountId } });
    if (!role) throw new AppError(ErrorCode.VALIDATION_FAILED, 'That role does not exist');
    return role.id;
  }
}

export { DEFAULT_ROLE_PERMISSIONS };
export type { Account };
