import type { ApiKey, Database } from '@smartchat/database';
import { ActorType as DbActorType } from '@smartchat/database';
import {
  ActorType,
  AppError,
  ErrorCode,
  Permission,
  permissionsForScopes,
  type TenantContext,
} from '@smartchat/types';
import type { CreateApiKeyInput } from '@smartchat/validation';
import { generateToken, hashToken, safeEqual, tokenFingerprint } from '../crypto/tokens.js';
import { AuditRepository } from '../repositories/audit.repository.js';
import { tenantScope } from '../repositories/scope.js';
import { requirePermission } from '../tenancy/context.js';
import { systemClock, type Clock } from '../time.js';

/**
 * API keys.
 *
 * The shape of the whole feature comes from one observation: `ActorType.api_key` was already in
 * this schema. A key is another kind of actor with a smaller permission set - not a parallel
 * authentication system with rules of its own. So it produces an ordinary `TenantContext`, goes
 * through the ordinary permission checks, and lands in the ordinary audit log. There is no second
 * authorisation path that could drift out of step with the first.
 *
 * A key looks like:
 *
 *     sck_a1b2c3d4e5f6_<43 characters of base64url>
 *         ^ prefix       ^ secret
 *
 * The prefix is an id, not a secret: it is indexed, it is what every request looks the key up by,
 * and it is what the dashboard shows so a person can tell two keys apart long after the secret has
 * gone. Only the secret's hash is stored, so a database dump contains no usable key.
 */

const KEY_PREFIX = 'sck';
const PREFIX_CHARS = 12;
const SECRET_BYTES = 32;
/** Where the secret starts: `sck_` plus the prefix plus one separator. */
const SECRET_OFFSET = KEY_PREFIX.length + 1 + PREFIX_CHARS + 1;

/** How stale `lastUsedAt` may get. A busy key must not write a row on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;

export interface ApiKeyServiceOptions {
  db: Database;
  clock?: Clock;
}

export interface CreatedApiKey {
  key: ApiKey;
  /** The only time this exists. Never stored, never recoverable, shown once. */
  secret: string;
}

export interface ApiKeyPrincipal {
  keyId: string;
  accountId: string;
  name: string;
  scopes: string[];
  propertyIds: string[];
}

/**
 * Split a presented key into its prefix and its secret.
 *
 * By **position**, not by searching for the last `_`. The secret is base64url, which includes `_`
 * and `-`, so a search-based split lands inside the secret for roughly half of all keys - which is
 * exactly the bug this replaced. The prefix is a fixed-length hex string precisely so that this
 * offset is exact, and it is a pure function precisely so that the case can be tested without a
 * database.
 */
export function splitApiKey(presented: string): { prefix: string; secret: string } | null {
  if (presented.length <= SECRET_OFFSET) return null;
  if (!presented.startsWith(`${KEY_PREFIX}_`)) return null;
  if (presented[SECRET_OFFSET - 1] !== '_') return null;

  const prefix = presented.slice(0, SECRET_OFFSET - 1);
  const secret = presented.slice(SECRET_OFFSET);
  // The prefix is hex by construction; anything else is not a key we issued.
  if (!/^[0-9a-f]+$/.test(prefix.slice(KEY_PREFIX.length + 1))) return null;
  if (secret.length < 20) return null;
  return { prefix, secret };
}

export class ApiKeyService {
  private readonly clock: Clock;
  private readonly audit: AuditRepository;

  constructor(private readonly options: ApiKeyServiceOptions) {
    this.clock = options.clock ?? systemClock;
    this.audit = new AuditRepository(options.db);
  }

  async list(context: TenantContext): Promise<ApiKey[]> {
    requirePermission(context, Permission.ACCOUNT_VIEW);
    return this.options.db.apiKey.findMany({
      where: { ...tenantScope(context) },
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  /**
   * Mint a key.
   *
   * `account:update` rather than anything softer: a key is a credential that outlives the person
   * who made it and cannot be watched over their shoulder, so creating one is an administrative
   * act even when the scopes are read-only.
   */
  async create(context: TenantContext, input: CreateApiKeyInput): Promise<CreatedApiKey> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);

    // A key cannot grant what its creator does not have. Otherwise "make an API key" becomes a
    // privilege-escalation primitive for anybody allowed to make one.
    const granted = permissionsForScopes(input.scopes);
    for (const permission of granted) {
      if (!context.permissions.has(permission)) {
        throw new AppError(
          ErrorCode.FORBIDDEN,
          'You cannot give a key access you do not have yourself',
        );
      }
    }

    /**
     * The prefix is hex, deliberately.
     *
     * It has to be a fixed length and contain no `_`, because the parser below finds the secret by
     * position rather than by searching for a separator - and base64url output contains both `-`
     * and `_`, which is exactly the bug this replaced: `lastIndexOf('_')` split inside the secret
     * whenever the secret happened to contain one, which was most of the time.
     */
    const prefix = `${KEY_PREFIX}_${tokenFingerprint(generateToken(16), PREFIX_CHARS)}`;
    const secret = generateToken(SECRET_BYTES);

    const key = await this.options.db.apiKey.create({
      data: {
        accountId: context.accountId,
        name: input.name,
        prefix,
        secretHash: hashToken(secret),
        scopes: input.scopes,
        propertyIds: input.propertyIds,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdByMemberId: context.memberId ?? null,
      },
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'api_key.created',
      resourceType: 'api_key',
      resourceId: key.id,
      ip: context.ip ?? null,
      // The scopes, never the secret. An audit log is read by more people than a key ever should be.
      metadata: { name: key.name, prefix: key.prefix, scopes: key.scopes },
    });

    return { key, secret: `${prefix}_${secret}` };
  }

  /**
   * Revoke, permanently.
   *
   * A timestamp rather than a delete: "which key was that, and when did we turn it off" is a
   * question somebody asks during an incident, and a row that no longer exists cannot answer it.
   */
  async revoke(context: TenantContext, id: string): Promise<void> {
    requirePermission(context, Permission.ACCOUNT_UPDATE);
    const key = await this.options.db.apiKey.findFirst({
      where: { ...tenantScope(context), id },
    });
    if (!key) throw new AppError(ErrorCode.NOT_FOUND);
    if (key.revokedAt) return;

    await this.options.db.apiKey.update({
      where: { id },
      data: { revokedAt: this.clock.now() },
    });

    await this.audit.record({
      accountId: context.accountId,
      actorType: DbActorType.user,
      actorId: context.userId ?? null,
      action: 'api_key.revoked',
      resourceType: 'api_key',
      resourceId: id,
      ip: context.ip ?? null,
      metadata: { name: key.name, prefix: key.prefix },
    });
  }

  /**
   * Turn a presented key into a principal, or refuse.
   *
   * Every refusal returns the same `null`, and the caller turns that into one error. Telling an
   * attacker whether a prefix exists, or whether a key is revoked rather than expired, hands them
   * a way to enumerate.
   */
  async authenticate(presented: string): Promise<ApiKeyPrincipal | null> {
    const parts = splitApiKey(presented);
    if (!parts) return null;
    const { prefix, secret } = parts;

    const key = await this.options.db.apiKey.findUnique({ where: { prefix } });
    if (!key) return null;
    if (!safeEqual(key.secretHash, hashToken(secret))) return null;

    const now = this.clock.now();
    if (key.revokedAt) return null;
    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) return null;

    const account = await this.options.db.account.findFirst({
      where: { id: key.accountId, deletedAt: null, status: 'active' },
      select: { id: true },
    });
    // A suspended account's keys stop working at the same moment its people do.
    if (!account) return null;

    // Written at most once a minute: "when was this key last used" is worth knowing, and worth
    // nowhere near a write on every request.
    if (!key.lastUsedAt || now.getTime() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      await this.options.db.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: now } })
        .catch(() => undefined);
    }

    return {
      keyId: key.id,
      accountId: key.accountId,
      name: key.name,
      scopes: key.scopes,
      propertyIds: key.propertyIds,
    };
  }

  /**
   * The tenant context a key acts through.
   *
   * Identical in kind to a member's, with three differences that matter: no `userId`, no
   * `memberId`, and a permission set derived from scopes rather than from a role. Anything that
   * needs a member - assigning a conversation to oneself, say - therefore fails on its own terms
   * rather than silently acting as nobody.
   */
  contextFor(principal: ApiKeyPrincipal, requestId: string, ip?: string): TenantContext {
    const context: TenantContext = {
      accountId: principal.accountId,
      actorType: ActorType.API_KEY,
      permissions: permissionsForScopes(principal.scopes),
      requestId,
    };
    if (ip) (context as { ip?: string }).ip = ip;
    (context as { actorName?: string }).actorName = principal.name;
    if (principal.propertyIds.length > 0) {
      (context as { propertyIds?: Set<string> }).propertyIds = new Set(principal.propertyIds);
    }
    return context;
  }
}
