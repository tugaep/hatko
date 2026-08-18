import type { Metadata, Viewport } from 'next';
import { Fraunces, Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

/**
 * Fonts are self-hosted by `next/font` at build time: no external stylesheet request,
 * no third-party connection, and no layout shift from a late-arriving face.
 *
 * Three families, three jobs. Any of them doing another's job is a bug.
 *
 * The UI and mono faces are Geist and Geist Mono — a Swiss neo-grotesque in the
 * Helvetica/Univers line, with closed apertures and horizontal terminals, and a mono
 * drawn against the same skeleton. They replaced Inter and IBM Plex Mono, which came
 * from two unrelated families. The local fallback chain names Helvetica Neue first, so
 * the face that swaps in before the webfont lands is the one it was chosen to resemble.
 */
const fraunces = Fraunces({
  subsets: ['latin'],
  // SOFT and WONK are what give Fraunces its field-guide character at display size.
  axes: ['SOFT', 'WONK'],
  variable: '--font-fraunces',
  display: 'swap',
});

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
  display: 'swap',
});

// Variable, so the 400/500/600 the type scale asks for come from one file rather than
// three static weights.
const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
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
    <html lang="en" className={`${fraunces.variable} ${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
