/**
 * Shared banner for /terms, /privacy, /dpa stubs. Makes it impossible to
 * accidentally ship draft legal text as if it were vetted. Replace these
 * pages with legal-team-reviewed copy before launch.
 */
export function LegalDraftBanner({ docName }: { docName: string }): JSX.Element {
  return (
    <div className="mx-auto mb-8 max-w-3xl rounded-lg border-2 border-destructive bg-destructive/10 px-6 py-4 text-sm leading-relaxed text-destructive">
      <strong className="mb-1.5 block text-[15px]">
        DRAFT — not legal advice, not enforceable
      </strong>
      The {docName} below is a placeholder skeleton for layout and review
      purposes only. It has <em>not</em> been reviewed by counsel and must be
      replaced with legal-team-approved copy before the public site goes live.
      If you are a tenant relying on these terms today, please contact{' '}
      <a href="mailto:legal@projexcloud.com" className="font-semibold underline">
        legal@projexcloud.com
      </a>{' '}
      for the current signed agreement.
    </div>
  );
}
