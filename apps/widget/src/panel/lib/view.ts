export type View = 'loading' | 'unavailable' | 'prechat' | 'chat' | 'offline' | 'offline_sent';

/**
 * Where the panel should be once a message arrives that the visitor did not send.
 *
 * A trigger can greet somebody who is still looking at the pre-chat form, or at the offline form.
 * Leaving them there would mean the widget started a conversation and then hid it - the visitor
 * sees an unread badge, opens the panel, and is asked for their email instead of being shown the
 * message. Worse than not greeting them at all.
 *
 * So an inbound message moves the panel to the conversation. The form has already served its
 * purpose by then: it exists to collect details *before* a conversation is opened, and one is now
 * open. Whatever the visitor had typed into it is not lost - `identify` still runs if they fill it
 * in later - but the message they were sent is the thing in front of them.
 */
export function viewAfterInboundMessage(current: View, senderType: string): View {
  if (senderType === 'visitor') return current;
  if (current === 'prechat' || current === 'offline' || current === 'offline_sent') return 'chat';
  return current;
}
