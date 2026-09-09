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
  crawlMaxPages: number;
  crawlExclude: string[];
  enabledAt: string | null;
  website: {
    url: string;
    syncing: boolean;
    lastSyncedAt: string | null;
    pagesFound: number;
    pagesIndexed: number;
    error: string | null;
  };
  plan: { includesAi: boolean; planName: string; repliesUsed: number; repliesLimit: number | null };
  knowledge: {
    documents: number;
    pages: number;
    files: number;
    chunks: number;
    articles: number;
    lastIndexedAt: string | null;
    pending: number;
    failures: Array<{ documentId: string; title: string; error: string }>;
  };
  usage: { replies: number; answers: number; chats: number; tickets: number; handoffs: number; failed: number };
}

export interface KnowledgeFileView {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunks: number;
  createdAt: string;
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
