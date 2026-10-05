import type { SystemMessageEvent } from './realtime';

/**
 * The agent-facing wording for a system message.
 *
 * The dashboard says "the visitor" where the panel says "you", and names the colleague who acted
 * rather than calling them "the support team" - the same event, told from this side of it. The
 * body the server wrote is the fallback for a kind this build does not know.
 */
export function systemText(message: {
  body: string;
  event?: SystemMessageEvent | undefined;
}): string {
  const event = message.event;
  if (!event) return message.body;

  switch (event.kind) {
    case 'conversation.closed':
      return `${actorOf(event)} ended this chat`;
    case 'conversation.reopened':
      return `${actorOf(event)} reopened this chat`;
    case 'call.started':
      return `${actorOf(event)} started a call`;
    case 'call.answered':
      if (event.by === 'ai') {
        return event.actorName
          ? `${event.actorName} (AI) answered the call`
          : 'The AI assistant answered the call';
      }
      return `${event.actorName ?? 'An agent'} answered the call`;
    case 'call.transferred':
      return `Transferred to ${event.targetName ?? 'a team member'}`;
    case 'call.missed':
      return 'Missed call';
    case 'call.ended':
      return event.durationSeconds
        ? `Call ended · ${formatCallDuration(event.durationSeconds)}`
        : 'Call ended';
    default:
      return message.body;
  }
}

/** Who did it, in the dashboard's words. */
function actorOf(event: SystemMessageEvent): string {
  switch (event.by) {
    case 'visitor':
      return 'The visitor';
    case 'ai':
      return event.actorName ? `${event.actorName} (AI)` : 'The AI assistant';
    case 'system':
      return 'The system';
    case 'agent':
      return event.actorName ?? 'An agent';
  }
}

/** "2 min 10 s", the way the server spells a duration in a system message body. */
export function formatCallDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}
