import Link from 'next/link';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';
import {
  PRICING_TIERS,
  PRICING_FEATURES,
  PRICING_OVERAGE,
  PRICING_NOTES,
  type FeatureStatus,
  type PricingFeature,
} from '../../config/pricing';

const WRAP: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', color: '#1b2a44', background: '#fff', minHeight: '100vh' };
const CONTAINER: React.CSSProperties = { maxWidth: 1100, margin: '0 auto', padding: '0 32px' };

const PAGE_HERO: React.CSSProperties = { padding: '72px 32px 24px', textAlign: 'center', background: 'linear-gradient(180deg, #fff 0%, #f5f9ff 100%)' };
const H1: React.CSSProperties = { fontSize: 44, fontWeight: 700, letterSpacing: '-0.02em', margin: '0 auto 12px', maxWidth: 720 };
const SUB: React.CSSProperties = { fontSize: 17, color: '#5a6573', maxWidth: 680, margin: '0 auto 0', lineHeight: 1.55 };

const TIER_GRID: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16,
  marginTop: 32, marginBottom: 56,
};
const TIER_CARD: React.CSSProperties = {
  padding: 28, border: '1px solid #d7dce4', borderRadius: 12, background: '#fff',
  display: 'flex', flexDirection: 'column',
};
const TIER_CARD_HIGHLIGHT: React.CSSProperties = {
  ...TIER_CARD, border: '2px solid #1a4fc4',
  boxShadow: '0 4px 12px rgba(26, 79, 196, 0.08)',
};
const TIER_NAME: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: '#1a4fc4', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 };
const TIER_PRICE: React.CSSProperties = { fontSize: 36, fontWeight: 700, letterSpacing: '-0.01em', margin: 0 };
const TIER_CAPTION: React.CSSProperties = { fontSize: 13, color: '#7a8597', marginTop: 6, marginBottom: 20, minHeight: 36 };
const TIER_TAGLINE: React.CSSProperties = { fontSize: 14, color: '#1b2a44', marginBottom: 20, lineHeight: 1.55, minHeight: 60 };
const TIER_CTA_PRIMARY: React.CSSProperties = {
  background: '#0b1220', color: '#fff', padding: '12px 16px', borderRadius: 6,
  textDecoration: 'none', fontSize: 14, fontWeight: 600, textAlign: 'center',
};
const TIER_CTA_SECONDARY: React.CSSProperties = {
  background: '#fff', color: '#0b1220', padding: '12px 16px', borderRadius: 6,
  textDecoration: 'none', fontSize: 14, fontWeight: 500, textAlign: 'center', border: '1px solid #d7dce4',
};

const TABLE: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', marginTop: 16, fontSize: 14 };
const TH: React.CSSProperties = { textAlign: 'left', padding: '14px 12px', borderBottom: '2px solid #d3dbe8', fontWeight: 600, background: '#f1f5fb' };
const TH_TIER: React.CSSProperties = { ...TH, textAlign: 'center', width: '20%' };
const TD: React.CSSProperties = { padding: '12px 12px', borderBottom: '1px solid #eef1f6', verticalAlign: 'top' };
const TD_TIER: React.CSSProperties = { ...TD, textAlign: 'center' };
const GROUP_ROW: React.CSSProperties = { background: '#f8fafd' };
const GROUP_TD: React.CSSProperties = { padding: '14px 12px', borderBottom: '1px solid #eef1f6', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.04em', color: '#1b2a44' };

const BADGE: React.CSSProperties = {
  display: 'inline-block', fontSize: 11, fontWeight: 600,
  background: '#fdf6e3', color: '#9a6e00', padding: '2px 8px',
  borderRadius: 999, marginLeft: 8, verticalAlign: 'middle',
  border: '1px solid #e3c47b', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const STATUS_CELL: Record<FeatureStatus, JSX.Element> = {
  included:    <span style={{ color: '#0d8a3d', fontWeight: 600 }}>✓</span>,
  addon:       <span style={{ color: '#5a6573' }}>Add-on</span>,
  unavailable: <span style={{ color: '#cfd5e0' }}>—</span>,
  roadmap:     <span style={{ color: '#9a6e00' }}>Q3 2026</span>,
};

function renderCell(value: FeatureStatus | string): JSX.Element {
  if (value === 'included' || value === 'addon' || value === 'unavailable' || value === 'roadmap') {
    return STATUS_CELL[value];
  }
  return <span>{value}</span>;
}

function FeatureRow({ row }: { row: PricingFeature }): JSX.Element {
  return (
    <tr>
      <td style={TD}>
        {row.label}
        {row.badge === 'q3-2026' && <span style={BADGE}>Q3 2026</span>}
        {row.badge === 'new'      && <span style={{ ...BADGE, background: '#e8f5e9', color: '#0d8a3d', borderColor: '#9bcfa3' }}>New</span>}
        {row.badge === 'beta'     && <span style={{ ...BADGE, background: '#ecf2fc', color: '#1a4fc4', borderColor: '#b9c3d6' }}>Beta</span>}
      </td>
      <td style={TD_TIER}>{renderCell(row.starter)}</td>
      <td style={TD_TIER}>{renderCell(row.pro)}</td>
      <td style={TD_TIER}>{renderCell(row.enterprise)}</td>
    </tr>
  );
}

export default function PricingPage(): JSX.Element {
  return (
    <div style={WRAP}>
      <MarketingHeader />

      <section style={PAGE_HERO}>
        <h1 style={H1}>Pricing</h1>
        <p style={SUB}>
          Three tiers — Starter for evaluation, Pro for production, Enterprise for
          regulated and sovereign deployments. AI tokens billed separately as usage;
          BYOK for AI keys puts that line on your provider invoice.
        </p>
      </section>

      <section style={{ padding: '24px 32px 0' }}>
        <div style={CONTAINER}>
          <div style={TIER_GRID}>
            {PRICING_TIERS.map((tier) => (
              <div key={tier.id} style={tier.highlight ? TIER_CARD_HIGHLIGHT : TIER_CARD}>
                <div style={TIER_NAME}>{tier.name}</div>
                <p style={TIER_PRICE}>{tier.price_monthly}</p>
                <p style={TIER_CAPTION}>{tier.price_caption}</p>
                <p style={TIER_TAGLINE}>{tier.tagline}</p>
                <div style={{ marginTop: 'auto' }}>
                  <Link
                    href={tier.cta_href}
                    style={tier.highlight ? TIER_CTA_PRIMARY : TIER_CTA_SECONDARY}
                  >
                    {tier.cta_label}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ padding: '32px 32px 56px' }}>
        <div style={CONTAINER}>
          <h2 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 4 }}>
            Compare plans
          </h2>
          <p style={{ fontSize: 14, color: '#5a6573', marginTop: 4, marginBottom: 16 }}>
            Every tier includes self-serve signup, the six-layer JWT, audit ledger,
            and the 70+ SDK catalog. Differences are about scale, deployment, compliance, and support.
          </p>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Feature</th>
                {PRICING_TIERS.map((t) => (
                  <th key={t.id} style={TH_TIER}>{t.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRICING_FEATURES.flatMap((group) => [
                <tr key={`group-${group.group}`} style={GROUP_ROW}>
                  <td colSpan={4} style={GROUP_TD}>{group.group}</td>
                </tr>,
                ...group.features.map((row, i) => (
                  <FeatureRow key={`${group.group}-${i}`} row={row} />
                )),
              ])}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ padding: '32px 32px 56px', background: '#f8fafd' }}>
        <div style={CONTAINER}>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 8 }}>
            Overage rates
          </h2>
          <p style={{ fontSize: 14, color: '#5a6573', marginBottom: 16 }}>
            When you exceed the included quota, the following rates apply automatically.
            Soft-cap warnings stamp on responses before the cap; hard-cap denies past it.
          </p>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Resource</th>
                {PRICING_TIERS.map((t) => (
                  <th key={t.id} style={TH_TIER}>{t.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRICING_OVERAGE.map((row, i) => (
                <tr key={i}>
                  <td style={TD}>{row.label}</td>
                  <td style={TD_TIER}>{row.starter}</td>
                  <td style={TD_TIER}>{row.pro}</td>
                  <td style={TD_TIER}>{row.enterprise}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={{ padding: '32px 32px 64px' }}>
        <div style={CONTAINER}>
          <h2 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 8 }}>
            Notes
          </h2>
          <ul style={{ paddingLeft: 20, fontSize: 14, color: '#5a6573', lineHeight: 1.7 }}>
            {PRICING_NOTES.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </div>
      </section>

      <section style={{ padding: '64px 32px', background: '#0b1220', color: '#f0f3f9', textAlign: 'center' }}>
        <h2 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.01em', marginBottom: 12 }}>
          Need a custom deployment?
        </h2>
        <p style={{ fontSize: 16, color: '#a4afc4', maxWidth: 600, margin: '0 auto 24px' }}>
          Sovereign regions, FedRAMP-Moderate, HIPAA BAA, on-prem bundles, custom
          SLAs — these live in the Enterprise tier. Tell us what you need.
        </p>
        <a href="mailto:sales@projexcloud.com" style={{ background: '#fff', color: '#0b1220', padding: '14px 28px', borderRadius: 8, textDecoration: 'none', fontSize: 16, fontWeight: 600 }}>
          Talk to sales
        </a>
      </section>

      <MarketingFooter />
    </div>
  );
}
