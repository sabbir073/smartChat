import type { Account, AccountMember, DatabaseOrTransaction, Role } from '@smartchat/database';
import { MemberRole, MemberStatus } from '@smartchat/database';
import { DEFAULT_ROLE_PERMISSIONS } from '@smartchat/types';
import type { TenantContext } from '@smartchat/types';
import { tenantScope } from './scope.js';

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
      },
      orderBy: [{ baseRole: 'asc' }, { createdAt: 'asc' }],
      take: 500,
    });
  }

  countActiveMembers(context: TenantContext): Promise<number> {
    return this.db.accountMember.count({
      where: { ...tenantScope(context), deletedAt: null, status: { not: MemberStatus.disabled } },
    });
  }
}
