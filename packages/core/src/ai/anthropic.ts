import {
  AiProviderError,
  fetchWithDeadline,
  readJson,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
} from './provider.js';

/**
 * Anthropic's Messages API as a chat provider.
 *
 * The wire format differs from the OpenAI one in two ways that matter here: the system prompt
 * is a field of its own rather than a message, and there is no `response_format`. The schema is
 * enforced the way that API does it - the reply is declared as a tool whose input schema is the
 * contract, and the model is told to call that tool and nothing else. The tool's input is the
 * JSON object; it is handed back as text so the caller's validation sees exactly what it sees
 * from every other provider. No tool ever executes: there is nothing on this side to run it.
 */

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Overrides the endpoint. Tests point it at a stub. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

interface MessagesResponse {
  model?: string;
  content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = 'anthropic' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    // The override is shared with the OpenAI-style providers, whose root ends in `/v1`; this API
    // puts the version in the path itself, so a trailing `/v1` is dropped rather than doubled.
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, '');
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await fetchWithDeadline(
      this.kind,
      `${this.baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: request.maxTokens,
          temperature: request.temperature,
          ...(system ? { system } : {}),
          messages,
          tools: [
            {
              name: 'reply',
              description: 'The reply, in the required shape.',
              input_schema: request.schema,
            },
          ],
          tool_choice: { type: 'tool', name: 'reply' },
        }),
      },
      request.timeoutMs,
    );
    const body = (await readJson(this.kind, response)) as MessagesResponse;
    const call = body.content?.find((block) => block.type === 'tool_use' && block.name === 'reply');
    if (!call || call.input === undefined) {
      const text = body.content?.find((block) => block.type === 'text')?.text;
      if (typeof text === 'string' && text.trim()) return this.result(text, body);
      throw new AiProviderError(this.kind, 'reply had no tool call and no text');
    }
    return this.result(JSON.stringify(call.input), body);
  }

  /** The console's test button: the smallest request that proves the key and the model. */
  async test(timeoutMs = 15_000): Promise<{ model: string }> {
    const result = await this.chat({
      messages: [{ role: 'user', content: 'Reply with ok set to true.' }],
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

  private result(content: string, body: MessagesResponse): ChatResult {
    return {
      content,
      model: body.model ?? this.model,
      promptTokens: body.usage?.input_tokens ?? 0,
      completionTokens: body.usage?.output_tokens ?? 0,
    };
  }
}
