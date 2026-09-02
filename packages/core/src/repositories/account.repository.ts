import type { Account, AccountMember, DatabaseOrTransaction, Role } from '@smartchat/database';
import { MemberRole, MemberStatus } from '@smartchat/database';
import { DEFAULT_ROLE_PERMISSIONS } from '@smartchat/types';
import type { TenantContext } from '@smartchat/types';
import { tenantScope } from './scope.js';
import { ensureSubscription } from '../billing/bootstrap.js';

export type MembershipWithRole = AccountMember & {
  role: Role | null;
  properties: { propertyId: string }[];
  account: Account;
  /**
   * Loaded so the tenant context can carry a display name.
   *
   * Without it every agent action is attributed to nobody: the name a visitor sees above a reply,
   * and the name in "X ended this chat", both come from here. Only the name is selected - the rest
   * of the user row, password hash included, has no business being attached to a request context.
   */
  user: { name: string } | null;
};

export class AccountRepository {
  constructor(private readonly db: DatabaseOrTransaction) {}

  findById(accountId: string): Promise<Account | null> {
    return this.db.account.findFirst({ where: { id: accountId, deletedAt: null } });
  }

  async slugExists(slug: string): Promise<boolean> {
    return (await this.db.account.count({ where: { slug } })) > 0;
  }

  /**
   * Create an account with its owner membership and the four default roles in one transaction.
   *
   * Roles are copied from the built-in defaults rather than referenced, so an account owner can
   * edit "Agent" for their organisation without affecting anyone else's.
   */
  async createWithOwner(input: {
    name: string;
    slug: string;
    ownerUserId: string;
    timezone: string;
    locale: string;
  }): Promise<{ account: Account; membership: AccountMember }> {
    const account = await this.db.account.create({
      data: {
        name: input.name,
        slug: input.slug,
        ownerUserId: input.ownerUserId,
        timezone: input.timezone,
        locale: input.locale,
        roles: {
          create: (Object.keys(DEFAULT_ROLE_PERMISSIONS) as MemberRole[]).map((key) => ({
            key,
            name: key.charAt(0).toUpperCase() + key.slice(1),
            description: `Default ${key} role`,
            permissions: [...(DEFAULT_ROLE_PERMISSIONS[key] ?? [])],
            isSystem: true,
          })),
        },
      },
    });

    const ownerRole = await this.db.role.findFirst({
      where: { accountId: account.id, key: MemberRole.owner },
    });

    const membership = await this.db.accountMember.create({
      data: {
        accountId: account.id,
        userId: input.ownerUserId,
        baseRole: MemberRole.owner,
        roleId: ownerRole?.id ?? null,
        status: MemberStatus.active,
        joinedAt: new Date(),
      },
    });

    /**
     * A subscription, before the account is handed back.
     *
     * Here rather than in the service that calls this, because this is the only place an account
     * comes into existence and an account without a subscription has no entitlements - which the
     * entitlement service reads as "no limits" rather than "no plan". One account created down a
     * path that forgot this step is one customer on an unmetered plan.
     */
    await ensureSubscription(this.db, account.id);

    return { account, membership };
  }

  /** The single lookup that turns "this user" into "this user, in this account, with these rights". */
  findMembership(userId: string, accountId: string): Promise<MembershipWithRole | null> {
    return this.db.accountMember.findFirst({
      where: { userId, accountId, deletedAt: null, account: { deletedAt: null } },
      include: {
        role: true,
        properties: { select: { propertyId: true } },
        account: true,
        user: { select: { name: true } },
      },
    });
  }

  listMembershipsForUser(userId: string): Promise<MembershipWithRole[]> {
    return this.db.accountMember.findMany({
      where: { userId, deletedAt: null, account: { deletedAt: null } },
      include: {
        role: true,
        properties: { select: { propertyId: true } },
        account: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  update(
    context: TenantContext,
    data: { name?: string; timezone?: string; locale?: string; dataRetentionDays?: number | null },
  ): Promise<Account> {
    return this.db.account.update({ where: { id: context.accountId }, data });
  }

  listMembers(context: TenantContext) {
    return this.db.accountMember.findMany({
      where: { ...tenantScope(context), deletedAt: null },
      include: {
        user: { select: { id: true, email: true, name: true, avatarUrl: true, lastLoginAt: true } },
        role: { select: { id: true, key: true, name: true } },
        properties: { select: { propertyId: true } },
        departments: { select: { departmentId: true } },
      },
      orderBy: [{ baseRole: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
  }

  findMemberById(context: TenantContext, memberId: string) {
    return this.db.accountMember.findFirst({
      where: { id: memberId, ...tenantScope(context), deletedAt: null },
      include: {
        user: { select: { id: true, email: true, name: true, avatarUrl: true, lastLoginAt: true } },
        role: { select: { id: true, key: true, name: true } },
        properties: { select: { propertyId: true } },
        departments: { select: { departmentId: true } },
      },
    });
  }

  findMemberByEmail(accountId: string, email: string) {
    return this.db.accountMember.findFirst({
      where: { accountId, deletedAt: null, user: { email } },
      include: { user: { select: { id: true, email: true } } },
    });
  }

  /** How many active owners the account has. The guard against locking everybody out. */
  countOwners(accountId: string): Promise<number> {
    return this.db.accountMember.count({
      where: { accountId, deletedAt: null, baseRole: 'owner', status: 'active' },
    });
  }

  createMember(data: {
    accountId: string;
    userId: string;
    baseRole: 'owner' | 'admin' | 'manager' | 'agent';
    status: 'active' | 'invited';
    invitedByUserId?: string | null;
    invitedAt?: Date | null;
    joinedAt?: Date | null;
    title?: string | null;
    restrictedToProperties: boolean;
  }) {
    return this.db.accountMember.create({ data });
  }

  updateMember(context: TenantContext, memberId: string, data: Record<string, unknown>) {
    return this.db.accountMember.updateMany({
      where: { id: memberId, ...tenantScope(context), deletedAt: null },
      data,
    });
  }

  /**
   * Replace a member's property scope.
   *
   * Delete-then-insert rather than a diff: the set is tiny, and a diff has more ways to leave the
   * table describing something nobody asked for.
   */
  async setMemberProperties(
    accountId: string,
    memberId: string,
    propertyIds: string[],
  ): Promise<void> {
    await this.db.propertyMember.deleteMany({ where: { accountId, memberId } });
    if (propertyIds.length === 0) return;
    await this.db.propertyMember.createMany({
      data: propertyIds.map((propertyId) => ({ accountId, propertyId, memberId })),
      skipDuplicates: true,
    });
  }

  async setMemberDepartments(
    accountId: string,
    memberId: string,
    departmentIds: string[],
  ): Promise<void> {
    await this.db.departmentMember.deleteMany({ where: { accountId, memberId } });
    if (departmentIds.length === 0) return;
    await this.db.departmentMember.createMany({
      data: departmentIds.map((departmentId) => ({ accountId, departmentId, memberId })),
      skipDuplicates: true,
    });
  }

  /** Which of these ids are real properties of this account. Guards against ids from elsewhere. */
  async existingPropertyIds(accountId: string, propertyIds: string[]): Promise<string[]> {
    if (propertyIds.length === 0) return [];
    const rows = await this.db.property.findMany({
      where: { accountId, deletedAt: null, id: { in: propertyIds } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async existingDepartmentIds(accountId: string, departmentIds: string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await this.db.department.findMany({
      where: { accountId, deletedAt: null, id: { in: departmentIds } },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

}
