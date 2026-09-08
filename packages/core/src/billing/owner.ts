import type { Database } from '@smartchat/database';

/**
 * Who billing mail goes to: the account's owner - the earliest active one, if there are several.
 *
 * Their display name on the account when they set one, their profile name otherwise, so the
 * greeting matches what their colleagues see.
 */
export async function findAccountOwner(
  db: Database,
  accountId: string,
): Promise<{ email: string; name: string } | null> {
  const owner = await db.accountMember.findFirst({
    where: { accountId, baseRole: 'owner', status: 'active', deletedAt: null },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: { email: true, name: true } } },
  });
  if (!owner) return null;
  return { email: owner.user.email, name: owner.displayName ?? owner.user.name };
}
