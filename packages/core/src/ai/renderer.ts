/**
 * The browser, at arm's length.
 *
 * Pages that are an empty shell until their JavaScript runs are read through a separate
 * container running a headless browser (`infrastructure/renderer`). This is the client for it:
 * one POST, a deadline, a shared secret, and nothing else. The crawler asks for a render only
 * when the plain fetch came back with nothing to read, so most sites never touch it.
 *
 * The renderer enforces the same address rules as the crawler on its own side (private ranges
 * refused, per request, before the browser connects) - this client does not have to trust it,
 * but it is not the last line either: the rendered HTML goes through the same extraction and
 * the same contract as everything else.
 */

export interface RendererOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface RenderedPage {
  html: string;
  finalUrl: string;
  status: number;
}

export class RendererClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: RendererOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The rendered page, or null when the renderer could not (down, refused, timed out). */
  async render(url: string): Promise<RenderedPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.base}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-renderer-token': this.options.token },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.options.log?.('ai.render.refused', { url, status: response.status });
        return null;
      }
      const body = (await response.json()) as Partial<RenderedPage>;
      if (typeof body.html !== 'string' || typeof body.finalUrl !== 'string') return null;
      return { html: body.html, finalUrl: body.finalUrl, status: typeof body.status === 'number' ? body.status : 200 };
    } catch (error) {
      this.options.log?.('ai.render.failed', { url, error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${this.base}/health`, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
