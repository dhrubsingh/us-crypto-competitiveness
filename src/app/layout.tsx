import type { Metadata } from 'next'
import Link from 'next/link'
import { Source_Serif_4, Inter } from 'next/font/google'
import './globals.css'

const serif = Source_Serif_4({
  variable: '--font-serif',
  subsets: ['latin'],
  weight: ['400', '600', '700'],
})

const sans = Inter({
  variable: '--font-sans',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'US Crypto Derivatives Market Structure Observatory',
  description:
    'Tracking the migration of crypto derivatives liquidity from offshore venues to CFTC-regulated US exchanges — and what fragmented liquidity costs US traders.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${serif.variable} ${sans.variable}`}>
      <body className="min-h-screen">
        <header className="border-b border-[var(--border)]">
          <div className="mx-auto flex max-w-[1080px] items-baseline justify-between px-5 py-3">
            <Link href="/" className="text-[13px] font-semibold tracking-wide text-[var(--ink)]">
              US Crypto Derivatives Observatory
            </Link>
            <nav className="flex gap-6 text-[13px] text-[var(--ink-2)]">
              <Link href="/" className="hover:text-[var(--ink)]">
                Dashboard
              </Link>
              <Link href="/methodology" className="hover:text-[var(--ink)]">
                Methodology
              </Link>
              <Link href="/data" className="hover:text-[var(--ink)]">
                Data
              </Link>
            </nav>
          </div>
        </header>
        {children}
        <footer className="mt-20 border-t border-[var(--border)]">
          <div className="mx-auto max-w-[1080px] px-5 py-8 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            <p>
              Open-source and built entirely on public, keyless data sources — venue APIs, the
              CFTC&rsquo;s Commitments of Traders reports, and public market archives. Sources and known
              limitations are documented on the{' '}
              <Link
                href="/methodology"
                className="underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--ink-2)]"
              >
                methodology page
              </Link>
              ; every dataset is downloadable from the{' '}
              <Link
                href="/data"
                className="underline decoration-[var(--border-strong)] underline-offset-2 hover:text-[var(--ink-2)]"
              >
                data page
              </Link>
              . Nothing here is investment advice.
            </p>
          </div>
        </footer>
      </body>
    </html>
  )
}
