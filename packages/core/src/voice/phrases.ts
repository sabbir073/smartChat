import {
  VOICE_PHRASE_KEYS,
  type VoiceLanguage,
  type VoicePhraseKey,
  type VoicePhrases,
} from '@smartchat/types';

/**
 * The fixed things the AI says on a call, in both languages.
 *
 * Everything the brain does not compose itself is here: the greeting, the two kinds of "hold on",
 * the ticket conversation, the hand-over, the goodbye. An owner may override any of them per
 * website; what they do not override comes from this table. The placeholders are the only
 * variable parts, and they are filled by the agent, never by the model.
 *
 *   {assistant}  the assistant's name          {business}  the website's name
 *   {number}     the ticket number             {email}     the address the ticket goes to
 */
export const DEFAULT_PHRASES: Record<VoicePhraseKey, Record<VoiceLanguage, string>> = {
  greeting: {
    en: 'Hello, you have reached {business}. This is {assistant}. How can I help you today?',
    bn: 'হ্যালো, {business}-এ আপনাকে স্বাগতম। আমি {assistant}। আমি আপনাকে কীভাবে সাহায্য করতে পারি?',
  },
  holdOn: {
    en: 'Hold on, let me check this for you.',
    bn: 'একটু অপেক্ষা করুন, আমি বিষয়টি দেখে নিচ্ছি।',
  },
  stillChecking: {
    en: 'I am still checking your previous question. I will come to this right after, one moment please.',
    bn: 'আমি এখনও আপনার আগের প্রশ্নটি দেখছি। এটি শেষ হলেই আমি আপনার নতুন কথায় আসছি, এক মুহূর্ত অপেক্ষা করুন।',
  },
  afterWait: {
    en: 'Thank you for waiting.',
    bn: 'অপেক্ষা করার জন্য ধন্যবাদ।',
  },
  ticketOffer: {
    en: 'Shall I create a ticket so a team member can look into this and get back to you by email? Please say yes or no.',
    bn: 'আমি কি একটি টিকিট তৈরি করব, যাতে আমাদের টিমের একজন বিষয়টি দেখে আপনাকে ইমেইলে জানাতে পারে? অনুগ্রহ করে হ্যাঁ বা না বলুন।',
  },
  ticketAskEmail: {
    en: 'Please type your email address in the chat box on your screen, so I get it exactly right. I will wait.',
    bn: 'অনুগ্রহ করে আপনার স্ক্রিনের চ্যাট বক্সে আপনার ইমেইল ঠিকানাটি লিখুন, যাতে আমি সেটি সঠিকভাবে পাই। আমি অপেক্ষা করছি।',
  },
  ticketCreated: {
    en: 'Done. Your ticket number is {number}. The team will reply to {email}. Is there anything else I can help with?',
    bn: 'হয়ে গেছে। আপনার টিকিট নম্বর {number}। টিম {email}-এ উত্তর দেবে। আর কিছু কি সাহায্য করতে পারি?',
  },
  ticketDeclined: {
    en: 'Alright, no ticket then. Is there anything else I can help with?',
    bn: 'ঠিক আছে, তাহলে টিকিট নয়। আর কিছু কি সাহায্য করতে পারি?',
  },
  handoff: {
    en: 'Let me connect you to a member of our team. Please hold while it rings.',
    bn: 'আমি আপনাকে আমাদের টিমের একজনের সাথে যুক্ত করে দিচ্ছি। অনুগ্রহ করে লাইনে থাকুন।',
  },
  handoffFailed: {
    en: 'I am sorry, nobody from the team could pick up right now. I can create a ticket so they get back to you by email. Shall I?',
    bn: 'দুঃখিত, এই মুহূর্তে টিমের কেউ ফোন ধরতে পারলেন না। আমি একটি টিকিট তৈরি করতে পারি, যাতে তারা আপনাকে ইমেইলে জানায়। করব কি?',
  },
  noAgent: {
    en: 'Our team is not online right now. I can create a ticket so they get back to you by email. Shall I?',
    bn: 'আমাদের টিম এখন অনলাইনে নেই। আমি একটি টিকিট তৈরি করতে পারি, যাতে তারা আপনাকে ইমেইলে জানায়। করব কি?',
  },
  stillThere: {
    en: 'Are you still there? Is there anything else I can help you with?',
    bn: 'আপনি কি এখনও লাইনে আছেন? আর কিছু কি সাহায্য করতে পারি?',
  },
  goodbye: {
    en: 'Thank you for calling {business}. Have a great day. Goodbye!',
    bn: '{business}-এ ফোন করার জন্য ধন্যবাদ। আপনার দিনটি শুভ হোক। বিদায়!',
  },
  maxLength: {
    en: 'We have reached the time limit for this call. You can call again any time, or keep chatting here. Goodbye!',
    bn: 'এই কলের সময়সীমা শেষ হয়ে গেছে। আপনি যেকোনো সময় আবার ফোন করতে পারেন, বা এখানে চ্যাট চালিয়ে যেতে পারেন। বিদায়!',
  },
};

export interface PhraseContext {
  assistant: string;
  business: string;
  number?: string | number;
  email?: string;
}

/** The phrase to say: the owner's override when there is one, the default otherwise. */
export function phrase(
  overrides: VoicePhrases | null | undefined,
  key: VoicePhraseKey,
  language: VoiceLanguage,
  context: PhraseContext,
): string {
  const custom = overrides?.[key]?.[language];
  const template = custom && custom.trim().length > 0 ? custom : DEFAULT_PHRASES[key][language];
  return fill(template, context);
}

/** The whole table for one website, defaults and overrides merged, for the settings page. */
export function resolvedPhrases(
  overrides: VoicePhrases | null | undefined,
): Record<VoicePhraseKey, Record<VoiceLanguage, string>> {
  const out = {} as Record<VoicePhraseKey, Record<VoiceLanguage, string>>;
  for (const key of VOICE_PHRASE_KEYS) {
    out[key] = {
      en: overrides?.[key]?.en?.trim() || DEFAULT_PHRASES[key].en,
      bn: overrides?.[key]?.bn?.trim() || DEFAULT_PHRASES[key].bn,
    };
  }
  return out;
}

function fill(template: string, context: PhraseContext): string {
  return template
    .replaceAll('{assistant}', context.assistant)
    .replaceAll('{business}', context.business)
    .replaceAll('{number}', context.number === undefined ? '' : String(context.number))
    .replaceAll('{email}', context.email ?? '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Keep only overrides that are real: a JSON bag from the database may hold anything, and a
 * phrase that is not a non-empty string for a known key and language is dropped, not spoken.
 */
export function readPhrases(raw: unknown): VoicePhrases {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: VoicePhrases = {};
  for (const key of VOICE_PHRASE_KEYS) {
    const entry = (raw as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const languages: Partial<Record<VoiceLanguage, string>> = {};
    for (const language of ['en', 'bn'] as const) {
      const value = (entry as Record<string, unknown>)[language];
      if (typeof value === 'string' && value.trim().length > 0)
        languages[language] = value.trim().slice(0, 400);
    }
    if (Object.keys(languages).length > 0) out[key] = languages;
  }
  return out;
}
