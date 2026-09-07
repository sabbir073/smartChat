import type { Database } from '@smartchat/database';

/**
 * Is anybody available to answer, right now?
 *
 * This decides whether a visitor is offered a live chat or an offline form, so getting it wrong is
 * not cosmetic — it either makes somebody wait for a reply nobody is going to send, or hides a
 * team that is sitting there waiting.
 *
 * It reads the *persisted* availability on the membership, which is the deliberate choice an agent
 * makes with the control in the dashboard. It used to be read from Redis presence instead, which
 * is written only while an agent holds an open socket to the realtime gateway — and the dashboard
 * only opens that socket on the Inbox page. So an agent who set themselves Online and then looked
 * at any other screen was published to every visitor as offline, and the answer never changed no
 * matter what they picked. Two stores, one written by the control and never read, the other read
 * by the widget and never written by the control.
 *
 * Liveness is deliberately *not* required on top of the choice. "Available" here means a person
 * said they are available; a product that also demands an open browser tab is one where closing a
 * laptop lid silently takes the whole team offline without anybody being told.
 */
export function agentAvailabilityReader(db: Database) {
  return async function hasAvailableAgent(accountId: string): Promise<boolean> {
    const member = await db.accountMember.findFirst({
      where: {
        accountId,
        availability: 'online',
        status: 'active',
        deletedAt: null,
        user: { deletedAt: null },
      },
      select: { id: true },
    });
    return member !== null;
  };
}
