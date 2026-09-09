import {
  AiProviderError,
  fetchWithDeadline,
  readJson,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
} from './provider.js';

/**
 * The hosted fallback: OpenAI, or DeepSeek through its OpenAI-compatible endpoint.
 *
 * One adapter for both because the wire format is the same; the difference is how firmly the
 * reply can be held to the schema. OpenAI accepts a JSON schema and constrains to it. DeepSeek
 * only guarantees "some JSON object", so the schema is spelled out in the system message as well
 * and the caller's validation does the rest - which it does for every provider anyway.
 */

export interface OpenAiCompatibleOptions {
  kind: 'openai' | 'deepseek';
  apiKey: string;
  model: string;
  /** Overrides the provider's default endpoint. Tests point it at a stub. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL: Record<OpenAiCompatibleOptions['kind'], string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements ChatProvider {
  readonly kind: 'openai' | 'deepseek';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAiCompatibleOptions) {
    this.kind = options.kind;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL[options.kind]).replace(/\/+$/, '');
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const messages =
      this.kind === 'deepseek'
        ? withSchemaInstruction(request.messages, request.schema)
        : request.messages;
    const responseFormat =
      this.kind === 'openai'
        ? {
            type: 'json_schema',
            json_schema: { name: 'reply', strict: true, schema: strictSchema(request.schema) },
          }
        : { type: 'json_object' };

    const response = await fetchWithDeadline(
      this.kind,
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          response_format: responseFormat,
        }),
      },
      request.timeoutMs,
    );
    const body = (await readJson(this.kind, response)) as ChatCompletionResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new AiProviderError(this.kind, 'reply had no message content');
    }
    return {
      content,
      model: body.model ?? this.model,
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
    };
  }

  /**
   * "Does this key work for this model?" - the console's test button. The smallest request the
   * API accepts, so a test costs a fraction of a cent and cannot be mistaken for usage.
   */
  async test(timeoutMs = 15_000): Promise<{ model: string }> {
    const result = await this.chat({
      messages: [{ role: 'user', content: 'Reply with the JSON object {"ok":true}.' }],
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      maxTokens: 20,
      temperature: 0,
      timeoutMs,
    });
    return { model: result.model };
  }
}

/** OpenAI's strict mode wants every property required and no extras, at every level. */
function strictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  if (out['type'] === 'object' && out['properties'] && typeof out['properties'] === 'object') {
    const properties = out['properties'] as Record<string, Record<string, unknown>>;
    out['properties'] = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, strictSchema(value)]),
    );
    out['required'] = Object.keys(properties);
    out['additionalProperties'] = false;
  }
  if (out['type'] === 'array' && out['items'] && typeof out['items'] === 'object') {
    out['items'] = strictSchema(out['items'] as Record<string, unknown>);
  }
  return out;
}

function withSchemaInstruction(
  messages: ChatRequest['messages'],
  schema: Record<string, unknown>,
): ChatRequest['messages'] {
  const instruction = `\n\nAnswer with a single JSON object and nothing else. It must match this JSON schema exactly:\n${JSON.stringify(schema)}`;
  const [first, ...rest] = messages;
  if (first && first.role === 'system') {
    return [{ role: 'system', content: first.content + instruction }, ...rest];
  }
  return [{ role: 'system', content: instruction.trim() }, ...messages];
}
