'use client';

/**
 * The last line of defence: an error thrown by the root layout itself.
 *
 * It replaces the entire document, so it must render its own <html> and <body> and cannot rely on
 * anything from the layout - including the stylesheet. The styles here are inline for that reason.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          background: '#f7f8fa',
          color: '#1a1d23',
        }}
      >
        <div style={{ textAlign: 'center', padding: '0 24px', maxWidth: 420 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 8px' }}>
            SmartChat could not start
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: '#5b616e', margin: '0 0 16px' }}>
            Reloading usually fixes this. If it does not, the reference below identifies the failure
            in our logs.
          </p>
          {error.digest && (
            <p style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#8a8f9a' }}>
              Reference: {error.digest}
            </p>
          )}
          <a
            href="/"
            style={{
              display: 'inline-block',
              marginTop: 16,
              padding: '10px 18px',
              borderRadius: 8,
              background: '#2f6fed',
              color: '#fff',
              textDecoration: 'none',
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            Reload
          </a>
        </div>
      </body>
    </html>
  );
}
