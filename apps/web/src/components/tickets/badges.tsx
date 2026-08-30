import { Badge } from '@/components/ui';
import type { TicketDto } from '@/lib/types';

/**
 * Colour carries meaning here, so it is chosen by what the state means to an agent rather than by
 * what looks tidy: open is work to do, pending is waiting on somebody else, resolved is done.
 */
const STATUS_TONE: Record<TicketDto['status'], 'brand' | 'warning' | 'success' | 'neutral'> = {
  open: 'brand',
  pending: 'warning',
  resolved: 'success',
  closed: 'neutral',
};

const PRIORITY_TONE: Record<TicketDto['priority'], 'neutral' | 'warning' | 'danger'> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

export function StatusBadge({ status }: { status: TicketDto['status'] }) {
  return <Badge tone={STATUS_TONE[status]}>{status}</Badge>;
}

/**
 * Normal priority is not shown at all.
 *
 * Nine tickets in ten are normal, and a badge on every row that says "normal" trains people to
 * stop reading badges - which is exactly when the urgent one goes unnoticed.
 */
export function PriorityBadge({ priority }: { priority: TicketDto['priority'] }) {
  if (priority === 'normal') return null;
  return <Badge tone={PRIORITY_TONE[priority]}>{priority}</Badge>;
}
