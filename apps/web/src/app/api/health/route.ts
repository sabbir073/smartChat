export const dynamic = 'force-dynamic';

/** Liveness only. The dashboard has no dependencies of its own to check. */
export function GET() {
  return Response.json({ status: 'ok', service: 'web' });
}
