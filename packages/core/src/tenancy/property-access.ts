import type { Database, DatabaseTransaction } from '@smartchat/database';
import { AppError, ErrorCode, type TenantContext } from '@smartchat/types';
import { requirePropertyAccess } from './context.js';

/**
 * Two different questions, asked together, because asking only one of them is a bug.
 *
 * `requirePropertyAccess` answers "is this member allowed on that website" - and for an
 * unrestricted owner the answer is always yes, including for a website belonging to a completely
 * different account. On its own that is enough for anything reached *through* a row we have
 * already loaded and tenant-scoped, because the row proves the property is ours.
 *
 * It is not enough when the property id is itself the filter. `WHERE account_id = mine AND
 * property_id = theirs` matches nothing, so the caller gets a cheerful, entirely empty answer:
 * a report of zeros, an empty article list. Nothing leaks - but the rule this codebase holds
 * everywhere else is that a resource which is not yours answers 404, and an empty report is a
 * worse answer than an error for the person who simply mistyped an id.
 *
 * So: does it exist in *this* account, and may *this* member see it.
 */
export async function assertPropertyInAccount(
  db: Database | DatabaseTransaction,
  context: TenantContext,
  propertyId: string,
  notFoundCode: ErrorCode = ErrorCode.PROPERTY_NOT_FOUND,
): Promise<void> {
  const property = await db.property.findFirst({
    where: { accountId: context.accountId, id: propertyId, deletedAt: null },
    select: { id: true },
  });
  if (!property) {
    throw new AppError(notFoundCode, undefined, {
      context: { propertyId, account: context.accountId },
    });
  }
  requirePropertyAccess(context, propertyId, notFoundCode);
}
