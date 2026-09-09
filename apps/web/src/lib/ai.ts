/**
 * The AI agent, as the dashboard sees it. Mirrors `AiSettingsView` in @smartchat/core.
 */

export type AiMode = 'team' | 'ai_when_offline' | 'ai';

export interface AiSettingsView {
  mode: AiMode;
  assistantName: string;
  instructions: string;
  keyFacts: string;
  ticketOfferText: string;
  handoffText: string;
  maxRepliesPerConversation: number;
  enabledAt: string | null;
  plan: { includesAi: boolean; planName: string; repliesUsed: number; repliesLimit: number | null };
  knowledge: {
    documents: number;
    chunks: number;
    articles: number;
    lastIndexedAt: string | null;
    pending: number;
    failures: Array<{ documentId: string; title: string; error: string }>;
  };
  usage: { replies: number; answers: number; tickets: number; handoffs: number; failed: number };
}

export const AI_MODES: ReadonlyArray<{ value: AiMode; label: string; short: string; description: string }> = [
  {
    value: 'team',
    label: 'Team',
    short: 'Team',
    description: 'People answer. When nobody is online, visitors leave a message that becomes a ticket.',
  },
  {
    value: 'ai_when_offline',
    label: 'AI when the team is offline',
    short: 'AI when offline',
    description: 'The assistant answers while no one is online, and steps back the moment someone is.',
  },
  {
    value: 'ai',
    label: 'AI answers first',
    short: 'AI first',
    description: 'The assistant answers every new message. Anyone on the team can still take a conversation over.',
  },
];

export function aiModeLabel(mode: AiMode): string {
  return AI_MODES.find((m) => m.value === mode)?.short ?? mode;
}
