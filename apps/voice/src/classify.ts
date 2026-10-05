/**
 * The few things the agent decides about a transcript without the model.
 *
 * A yes or a no to the ticket question, "cancel" while an email is awaited, and the filler a
 * caller produces while waiting ("ok", "hello?", "হুম") - these are answered in a few
 * milliseconds by a word list, not in six seconds by the brain. The lists are short and in both
 * languages; anything they do not recognise goes to the model as a question, which is the safe
 * direction to be wrong in.
 */

/** Words that are a yes wherever they appear in a short answer, or open a long one. */
const YES_STRONG = [
  'yes',
  'yeah',
  'yep',
  'yup',
  'sure',
  'go ahead',
  'do it',
  'হ্যাঁ',
  'হ্যা',
  'জি',
  'জ্বি',
  'অবশ্যই',
  'করুন',
  'করেন',
];
/**
 * Words that are a yes only on their own: "ok" is a yes, "ok so what time do you open" is a
 * question, and "please" alone is a yes while "please tell me your hours" is not.
 */
const YES_WEAK = ['ok', 'okay', 'please', 'create', 'create it', 'ঠিক আছে', 'আচ্ছা'];

const NO_STRONG = [
  'no',
  'nope',
  'not now',
  'no thanks',
  'no thank you',
  'না',
  'নাহ',
  'দরকার নেই',
  'লাগবে না',
  'থাক',
];
/** "Don't" alone is a no; "I don't know my order number" is an answer to something else. */
const NO_WEAK = ["don't", 'dont'];

const CANCEL_PHRASES = ['cancel', 'no', 'না', 'নাহ', 'থাক', 'বাতিল'];

const FILLER_PHRASES = [
  'hello',
  'hi',
  'hey',
  'ok',
  'okay',
  'hmm',
  'hm',
  'mm',
  'uh',
  'um',
  'yes',
  'yeah',
  'yep',
  'right',
  'thanks',
  'thank you',
  'আচ্ছা',
  'হ্যালো',
  'ঠিক আছে',
  'জি',
  'জ্বি',
  'হুম',
  'আছেন',
  'হ্যাঁ',
];

/** How many words a transcript may have and still be read as a plain yes or no. */
const SHORT_ANSWER_WORDS = 6;
/** A weak word counts only when the whole answer is this short: "ok", "yes please", "ok do it". */
const WEAK_ANSWER_WORDS = 3;
const FILLER_MAX_WORDS = 3;

/**
 * Lower-cased, punctuation gone (the danda included), one space between words. Combining
 * marks stay: a Bengali vowel sign is a mark, not a letter, and dropping it would leave "করুন"
 * as a different word.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(text: string): string[] {
  return text ? text.split(' ') : [];
}

/** Whether `phrase` occurs in `text` as whole words. */
function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function startsWithPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.startsWith(`${phrase} `);
}

/**
 * A yes, a no, or neither.
 *
 * A short answer may carry a strong word anywhere ("yes please do"); a long one only counts when
 * it opens with one ("no, actually I wanted to ask about delivery"). Weak words - "ok", "please",
 * "don't" - count only in an answer of a few words, because "ok so what are your hours" is a
 * question that happens to start with a filler, and must reach the model. No wins over yes when
 * both appear: "yes... no, not now" is a no.
 */
export function classifyYesNo(text: string): 'yes' | 'no' | 'unclear' {
  const clean = normalise(text);
  if (!clean) return 'unclear';
  const count = words(clean).length;
  const strong = (phrases: string[]): boolean =>
    phrases.some((phrase) =>
      count <= SHORT_ANSWER_WORDS ? containsPhrase(clean, phrase) : startsWithPhrase(clean, phrase),
    );
  const weak = (phrases: string[]): boolean =>
    count <= WEAK_ANSWER_WORDS && phrases.some((phrase) => containsPhrase(clean, phrase));
  if (strong(NO_STRONG) || weak(NO_WEAK)) return 'no';
  if (strong(YES_STRONG) || weak(YES_WEAK)) return 'yes';
  return 'unclear';
}

/** "Cancel" while the agent waits for an email: the ticket is abandoned. */
export function isCancel(text: string): boolean {
  const clean = normalise(text);
  if (!clean || words(clean).length > SHORT_ANSWER_WORDS) return false;
  return CANCEL_PHRASES.some((phrase) => containsPhrase(clean, phrase));
}

/**
 * Something a caller says to the silence rather than to the assistant: at most three words, all
 * of them from the list ("ok", "hello?", "ঠিক আছে"). Ignored while the brain is busy, so the
 * previous question is not interrupted by a sound that asked for nothing.
 */
export function isFiller(text: string): boolean {
  const clean = normalise(text);
  if (!clean) return true;
  const tokens = words(clean);
  if (tokens.length > FILLER_MAX_WORDS) return false;
  if (FILLER_PHRASES.includes(clean)) return true;
  return tokens.every((token) => FILLER_PHRASES.includes(token));
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u;

/** The first email address in a chat message, lower-cased, or null. */
export function extractEmail(text: string): string | null {
  const match = EMAIL.exec(text);
  return match ? match[0].toLowerCase() : null;
}
