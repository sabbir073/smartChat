import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import { AiProviderError } from './provider.js';

const schema = { type: 'object', properties: { decision: { type: 'string' } }, required: ['decision'] };

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

describe('AnthropicProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the system prompt as a field, forces the reply tool, and returns its input as JSON text', async () => {
    const fetchMock = respond({
      model: 'claude-haiku-4-5',
      content: [{ type: 'tool_use', id: 't1', name: 'reply', input: { decision: 'chat', text: 'Hi!' } }],
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-x', model: 'claude-haiku-4-5', baseUrl: 'https://stub.example' });
    const result = await provider.chat({
      messages: [
        { role: 'system', content: 'Rules.' },
        { role: 'user', content: 'Hello' },
      ],
      schema,
      maxTokens: 50,
      temperature: 0.2,
      timeoutMs: 1_000,
    });
    expect(JSON.parse(result.content)).toEqual({ decision: 'chat', text: 'Hi!' });
    expect(result).toMatchObject({ model: 'claude-haiku-4-5', promptTokens: 12, completionTokens: 5 });

    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stub.example/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-ant-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.system).toBe('Rules.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'reply' });
    expect(body.tools[0].input_schema).toEqual(schema);
  });

  it('turns a refused key into a provider error with the status', async () => {
    vi.stubGlobal('fetch', respond({ type: 'error', error: { message: 'invalid x-api-key' } }, 401));
    const provider = new AnthropicProvider({ apiKey: 'bad', model: 'claude-haiku-4-5' });
    await expect(provider.test(1_000)).rejects.toMatchObject({ name: 'AiProviderError', status: 401 });
  });

  it('refuses a reply with neither a tool call nor text', async () => {
    vi.stubGlobal('fetch', respond({ content: [] }));
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'm' });
    await expect(
      provider.chat({ messages: [{ role: 'user', content: 'x' }], schema, maxTokens: 5, temperature: 0, timeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});
