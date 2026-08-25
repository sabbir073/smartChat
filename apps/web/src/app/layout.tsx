import type { Metadata, Viewport } from 'next';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = serialiseRuntimeConfig(readRuntimeConfig());

  return (
    <html lang="en">
      <head>
        {/* Injected by the server so one image works in every environment. */}
        <script
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
