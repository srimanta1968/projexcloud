/**
 * Shared banner for /terms, /privacy, /dpa stubs. Makes it impossible to
 * accidentally ship draft legal text as if it were vetted. Replace these
 * pages with legal-team-reviewed copy before launch.
 */
const BANNER: React.CSSProperties = {
  background: '#fdecea', border: '2px solid #c12f1c', borderRadius: 8,
  padding: '16px 22px', margin: '0 auto 32px', maxWidth: 880,
  color: '#4f1411', fontSize: 14, lineHeight: 1.6,
};

export function LegalDraftBanner({ docName }: { docName: string }): JSX.Element {
  return (
    <div style={BANNER}>
      <strong style={{ display: 'block', fontSize: 15, marginBottom: 6 }}>
        DRAFT — not legal advice, not enforceable
      </strong>
      The {docName} below is a placeholder skeleton for layout and review
      purposes only. It has <em>not</em> been reviewed by counsel and must be
      replaced with legal-team-approved copy before the public site goes live.
      If you are a tenant relying on these terms today, please contact{' '}
      <a href="mailto:legal@projexcloud.com" style={{ color: '#4f1411', fontWeight: 600 }}>
        legal@projexcloud.com
      </a>{' '}
      for the current signed agreement.
    </div>
  );
}
