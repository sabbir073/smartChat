import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth-context';
import {
  RUNTIME_CONFIG_GLOBAL,
  readRuntimeConfig,
  serialiseRuntimeConfig,
} from '@/lib/runtime-config';
import { ToastProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'SmartChat',
    template: '%s · SmartChat',
  },
  description: 'Live chat for your websites: one inbox, every conversation, in real time.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

/**
 * Reading the request headers here does two jobs, and the second is the important one.
 *
 * It fetches the per-request nonce that `middleware.ts` minted, which the one inline script below
 * needs in order to run at all under the Content Security Policy. And by reading headers it opts
 * every route out of static prerendering - which is *required*, not incidental: a page rendered at
 * build time cannot carry a nonce that is generated per request, so Next leaves its own inline
 * bootstrap scripts un-nonced and the policy blanks the application.
 *
 * That is not a hypothetical. The first version of this CSP was served against prerendered pages,
 * and every script tag in the delivered HTML came back without a nonce. See ADR-084.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const config = serialiseRuntimeConfig(readRuntimeConfig());
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html lang="en">
      <head>
        {/*
          The only inline script in the application, and the only use of dangerouslySetInnerHTML.
          Its content is built from environment values this server read, never from anything a
          request supplied, and it carries the nonce so the policy stays strict rather than being
          relaxed to accommodate it.
        */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `window.${RUNTIME_CONFIG_GLOBAL}=${config};`,
          }}
        />
      </head>
      <body>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:shadow-lg"
        >
          Skip to content
        </a>
        <AuthProvider>
          <ToastProvider>{children}</ToastProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
