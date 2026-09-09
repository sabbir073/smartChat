/**
 * The model, as the rest of the system sees it: text in, text out.
 *
 * A provider receives a list of messages and a JSON schema, and returns a string that should fit
 * the schema. It has no tools, no callbacks and nothing to call back into. That is the security
 * design of the whole feature in one sentence - a hijacked prompt has nothing to reach - and it is
 * why the interface is this small. Everything the model must never do is a method that does not
 * exist.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** The JSON schema the reply must fit. Providers that can constrain decoding do; the rest are asked. */
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature: number;
  /** Absolute deadline. A provider that cannot answer by then aborts and throws `AiTimeoutError`. */
  timeoutMs: number;
}

export interface ChatResult {
  /** The raw reply. The caller parses and validates it; a provider never interprets it. */
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  promptTokens: number;
}

export type AiProviderKind = 'local' | 'openai' | 'deepseek' | 'anthropic';

export interface ChatProvider {
  readonly kind: AiProviderKind;
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /** Passages, for indexing. The texts are prefixed the way the model was trained to expect. */
  embedDocuments(texts: Array<{ title: string | null; text: string }>, timeoutMs: number): Promise<EmbedResult>;
  /** One question, for retrieval. */
  embedQuery(text: string, timeoutMs: number): Promise<number[]>;
}

/** The provider did not answer in time. Distinguished so the gateway can fall back rather than retry. */
export class AiTimeoutError extends Error {
  constructor(provider: AiProviderKind, timeoutMs: number) {
    super(`${provider} did not answer within ${timeoutMs}ms`);
    this.name = 'AiTimeoutError';
  }
}

/** The provider answered with an error, or could not be reached. */
export class AiProviderError extends Error {
  constructor(
    public readonly provider: AiProviderKind,
    message: string,
    public readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'AiProviderError';
  }
}

/**
 * `fetch` with a deadline, translating the two failure modes into the two error classes above.
 * Shared by the providers; nothing else in the module makes a request.
 */
export async function fetchWithDeadline(
  provider: AiProviderKind,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new AiTimeoutError(provider, timeoutMs);
    const message = error instanceof Error ? error.message : String(error);
    throw new AiProviderError(provider, `unreachable (${message})`);
  } finally {
    clearTimeout(timer);
  }
}

/** Read a JSON body, or throw a provider error naming the status. Bodies are never logged whole. */
export async function readJson(provider: AiProviderKind, response: Response): Promise<unknown> {
  if (!response.ok) {
    let detail = '';
    try {
      const text = await response.text();
      detail = text.slice(0, 300);
    } catch {
      // The status is the message.
    }
    throw new AiProviderError(
      provider,
      `HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
      response.status,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new AiProviderError(provider, 'response was not JSON', response.status);
  }
}
