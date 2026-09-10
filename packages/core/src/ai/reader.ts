/**
 * The page reader, at arm's length.
 *
 * Pages are read through a separate container running crawl4ai and a headless browser
 * (`infrastructure/crawl4ai`): it runs the page's JavaScript, drops the navigation, footers and
 * overlays, and returns markdown with the page's headings kept, plus the links the page carries.
 * This is the client for it: one POST, a deadline, a shared secret, and nothing else.
 *
 * The reader enforces the same address rules as the crawler on its own side (private ranges
 * refused, per request and per sub-request, before the browser connects) - this client does not
 * have to trust it, but it is not the last line either: what comes back goes through the same
 * chunker and the same contract as everything else, and the crawler decides what to do with it.
 */

export interface ReaderOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface ReadPage {
  finalUrl: string;
  /** The page's own HTTP status, as the browser saw it. */
  status: number;
  title: string | null;
  description: string | null;
  /** The page's main content as markdown: headings, lists, tables; no links, no images. */
  markdown: string;
  /** The rendered HTML, for the crawler's own link extraction and challenge detection. */
  html: string;
  /** Absolute URLs the page links to, as rendered. */
  links: string[];
}

export class ReaderClient {
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ReaderOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 45_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** The page as read, or null when the reader could not (down, refused, timed out). */
  async read(url: string): Promise<ReadPage | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.base}/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-crawl-token': this.options.token },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.options.log?.('ai.read.refused', { url, status: response.status });
        return null;
      }
      const body = (await response.json()) as Partial<ReadPage>;
      if (typeof body.markdown !== 'string' || typeof body.finalUrl !== 'string' || typeof body.html !== 'string') return null;
      return {
        finalUrl: body.finalUrl,
        status: typeof body.status === 'number' ? body.status : 200,
        title: typeof body.title === 'string' && body.title ? body.title : null,
        description: typeof body.description === 'string' && body.description ? body.description : null,
        markdown: body.markdown,
        html: body.html,
        links: Array.isArray(body.links) ? body.links.filter((link): link is string => typeof link === 'string') : [],
      };
    } catch (error) {
      this.options.log?.('ai.read.failed', { url, error: error instanceof Error ? error.message : String(error) });
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
