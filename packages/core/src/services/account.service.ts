import type { Account, Database } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import { AppError, ErrorCode, Permission, type TenantContext } from '@smartchat/types';
import type { UpdateAccountInput } from '@smartchat/validation';
import { AccountRepository, type MembershipWithRole } from '../repositories/account.repository.js';
import { AuditAction, AuditRepository } from '../repositories/audit.repository.js';
import { requirePermission } from '../tenancy/context.js';
import type { EntitlementService } from './entitlement.service.js';

export interface AccountSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  status: string;
}

export class AccountService {
  private readonly repo: AccountRepository;
  private readonly audit: AuditRepository;

  constructor(
    db: Database,
    private readonly entitlements: EntitlementService,
  ) {
    this.repo = new AccountRepository(db);
    this.audit = new AuditRepository(db);
  }

  /** Every account this user belongs to, for the account switcher. */
  async listForUser(userId: string): Promise<AccountSummary[]> {
    const memberships = await this.repo.listMembershipsForUser(userId);
    return memberships.map((membership) => ({
      id: membership.account.id,
      name: membership.account.name,
      slug: membership.account.slug,
      role: membership.baseRole,
      status: membership.account.status,
    }));
  }

  /**
   * Resolve one membership, refusing suspended accounts.
   *
   * This is the choke point where a platform-level suspension becomes real for the tenant: because
   * sessions are opaque and re-resolved on every request, suspending an account stops access
   * immediately rather than when a token happens to expire.
   */
  async requireMembership(userId: string, accountId: string): Promise<MembershipWithRole> {
    const membership = await this.repo.findMembership(userId, accountId);
    if (!membership) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    if (membership.account.status === 'suspended') {
      throw new AppError(ErrorCode.ACCOUNT_SUSPENDED);
    }
    if (membership.account.status === 'pending_deletion') {
      throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    }
    return membership;
  }

  async get(context: TenantContext): Promise<Account> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    const account = await this.repo.findById(context.accountId);
    if (!account) throw new AppError(ErrorCode.ACCOUNT_NOT_FOUND);
    return account;
  }

  async update(context: TenantContext, input: UpdateAccountInput): Promise<Account> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const account = await this.repo.update(context, input);

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: AuditAction.ACCOUNT_UPDATED,
      resourceType: 'account',
      resourceId: context.accountId,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      metadata: { changed: Object.keys(input) },
    });

    this.entitlements.invalidate(context.accountId);
    return account;
  }

  async listMembers(context: TenantContext) {
    requirePermission(context, Permission.MEMBER_VIEW);
    return this.repo.listMembers(context);
  }
}
