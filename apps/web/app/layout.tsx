import type { Metadata, Viewport } from 'next';
import { Fraunces, IBM_Plex_Mono, Inter } from 'next/font/google';
import './globals.css';

/**
 * Fonts are self-hosted by `next/font` at build time: no external stylesheet request,
 * no third-party connection, and no layout shift from a late-arriving face.
 *
 * Three families, three jobs. Any of them doing another's job is a bug.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  // SOFT and WONK are what give Fraunces its field-guide character at display size.
  axes: ['SOFT', 'WONK'],
  variable: '--font-fraunces',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'hatko',
  description:
    'Semantic search and grounded answers over an internal document corpus. Every claim carries its source.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#f7f4ec',
  colorScheme: 'light',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
