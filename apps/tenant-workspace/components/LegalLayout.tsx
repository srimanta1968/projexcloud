import type { ReactNode } from 'react';
import { MarketingHeader } from './MarketingHeader';
import { MarketingFooter } from './MarketingFooter';
import { LegalDraftBanner } from './LegalDraftBanner';

/**
 * Shared chrome + prose styling for the legal pages (/terms, /privacy, /dpa).
 * Headings, paragraphs, lists, links, and code inside `children` are styled
 * via descendant selectors so each page only carries its actual copy.
 */
const PROSE =
  'mx-auto max-w-3xl px-8 pb-20 pt-8 ' +
  '[&_h2]:mb-3 [&_h2]:mt-8 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:tracking-tight ' +
  '[&_p]:mb-3 [&_p]:text-[15px] [&_p]:leading-relaxed ' +
  '[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-[15px] [&_ul]:leading-relaxed ' +
  '[&_a]:text-primary [&_a]:underline ' +
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5';

export function LegalLayout({
  docName,
  title,
  children,
}: {
  docName: string;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />
      <div className={PROSE}>
        <LegalDraftBanner docName={docName} />
        <h1 className="mb-2 text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mb-8 text-xs text-muted-foreground">Last updated: TBD — DRAFT</p>
        {children}
      </div>
      <MarketingFooter />
    </div>
  );
}
