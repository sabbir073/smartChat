import {
  AiProviderError,
  fetchWithDeadline,
  readJson,
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  type EmbeddingProvider,
  type EmbedResult,
} from './provider.js';

/**
 * The local models, served by Ollama in the `ai` container.
 *
 * Two things about how it is called are worth knowing. `format` carries the JSON schema and
 * Ollama constrains decoding to it, so a 2B model that would otherwise wander produces exactly the
 * shape asked for. `think: false` turns off the Qwen 3.5 reasoning pass, which on a CPU would
 * otherwise spend twenty seconds thinking about opening hours.
 */

export interface OllamaOptions {
  baseUrl: string;
  chatModel: string;
  embedModel: string;
  embedDimensions: number;
  /** The prompt window. The prompt builder budgets to stay well inside it. */
  contextTokens?: number;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

interface OllamaEmbedResponse {
  model?: string;
  embeddings?: number[][];
  prompt_eval_count?: number;
}

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

export class OllamaProvider implements ChatProvider, EmbeddingProvider {
  readonly kind = 'local' as const;
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly contextTokens: number;

  constructor(options: OllamaOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.chatModel;
    this.embedModel = options.embedModel;
    this.dimensions = options.embedDimensions;
    this.contextTokens = options.contextTokens ?? 4096;
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const response = await fetchWithDeadline(
      'local',
      `${this.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          stream: false,
          think: false,
          format: request.schema,
          keep_alive: -1,
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
            num_ctx: this.contextTokens,
          },
        }),
      },
      request.timeoutMs,
    );
    const body = (await readJson('local', response)) as OllamaChatResponse;
    const content = body.message?.content;
    if (typeof content !== 'string') {
      throw new AiProviderError('local', 'reply had no message content');
    }
    return {
      content,
      model: body.model ?? this.model,
      promptTokens: body.prompt_eval_count ?? 0,
      completionTokens: body.eval_count ?? 0,
    };
  }

  /**
   * EmbeddingGemma's prompt convention: passages are `title: … | text: …`, questions are
   * `task: search result | query: …`. The model was trained with these and retrieval measurably
   * improves with them; another embedding model would want its own, which is why the prefixing
   * lives in the provider and not in the indexer.
   */
  async embedDocuments(
    texts: Array<{ title: string | null; text: string }>,
    timeoutMs: number,
  ): Promise<EmbedResult> {
    const input = texts.map((entry) => `title: ${entry.title ?? 'none'} | text: ${entry.text}`);
    return this.embed(input, timeoutMs);
  }

  async embedQuery(text: string, timeoutMs: number): Promise<number[]> {
    const result = await this.embed([`task: search result | query: ${text}`], timeoutMs);
    const vector = result.vectors[0];
    if (!vector) throw new AiProviderError('local', 'embedding reply was empty');
    return vector;
  }

  private async embed(input: string[], timeoutMs: number): Promise<EmbedResult> {
    if (input.length === 0) return { vectors: [], model: this.embedModel, promptTokens: 0 };
    const response = await fetchWithDeadline(
      'local',
      `${this.baseUrl}/api/embed`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.embedModel, input, keep_alive: -1, truncate: true }),
      },
      timeoutMs,
    );
    const body = (await readJson('local', response)) as OllamaEmbedResponse;
    const vectors = body.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== input.length) {
      throw new AiProviderError('local', 'embedding reply did not match the input');
    }
    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new AiProviderError(
          'local',
          `embedding has ${vector.length} dimensions, expected ${this.dimensions}`,
        );
      }
    }
    return { vectors, model: body.model ?? this.embedModel, promptTokens: body.prompt_eval_count ?? 0 };
  }

  /**
   * Is the server up and does it have both models? Cheap - one GET - and the answer the console
   * shows. Loading state is not checked: a model that is present but cold answers, just slowly.
   */
  async health(timeoutMs = 5_000): Promise<LocalHealth> {
    const response = await fetchWithDeadline('local', `${this.baseUrl}/api/tags`, { method: 'GET' }, timeoutMs);
    const body = (await readJson('local', response)) as OllamaTagsResponse;
    const names = new Set(
      (body.models ?? []).flatMap((entry) => [entry.name, entry.model]).filter((n): n is string => !!n),
    );
    const has = (model: string): boolean => names.has(model) || names.has(`${model}:latest`);
    return {
      reachable: true,
      chatModel: this.model,
      chatModelPresent: has(this.model),
      embedModel: this.embedModel,
      embedModelPresent: has(this.embedModel),
    };
  }
}

export interface LocalHealth {
  reachable: boolean;
  chatModel: string;
  chatModelPresent: boolean;
  embedModel: string;
  embedModelPresent: boolean;
}
