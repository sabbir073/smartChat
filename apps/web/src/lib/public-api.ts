/**
 * The server's own door to the API, used by the public help centre.
 *
 * Server-side only: it reads `process.env` and talks to an address that only exists inside the
 * network, so importing it from a client component would produce a request the browser cannot
 * make. Every caller below is a server component.
 *
 * The dashboard talks to the API from the browser, because every request there carries the
 * reader's session. The help centre has no reader identity at all, so it is rendered on the
 * server: the page arrives complete, works without JavaScript, and can be read by a search engine
 * - which is most of the point of publishing help articles in the first place.
 *
 * `INTERNAL_API_URL` is the address of the API *from inside the network*, which is not the address
 * the browser uses. Falling back to the browser-facing one keeps `next dev` on a laptop working.
 */
function internalApiBase(): string {
  return process.env['INTERNAL_API_URL'] ?? process.env['API_URL'] ?? 'http://localhost:3001';
}

export class PublicApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(`Public API responded ${status}`);
    this.name = 'PublicApiError';
  }

  /** A missing property and an unpublished article are the same answer to a stranger. */
  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export async function publicApiGet<T>(
  path: string,
  query: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(`${internalApiBase()}/api/v1${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json' },
    // The API sets its own cache-control; Next is told to revalidate on the same rhythm rather
    // than caching a help centre for the lifetime of the deployment.
    next: { revalidate: 60 },
  });

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PublicApiError(response.status, 'MALFORMED_RESPONSE');
  }

  const envelope = payload as
    { success: true; data: T } | { success: false; error: { code: string } };

  if (!response.ok || envelope.success === false) {
    throw new PublicApiError(
      response.status,
      (envelope as { error?: { code: string } }).error?.code ?? 'INTERNAL_ERROR',
    );
  }

  return envelope.data;
}
