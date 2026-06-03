/**
 * Public pricing config — single source of truth for the /pricing page.
 *
 * Pricing is a business decision the team will tune; this file is the
 * lever. Numbers below are v0 anchors, not validated against COGS.
 *
 * BYOK for AI keys (FR-BYOK-1..14) is tracked under epic 76ec75df and is
 * currently in-flight on the p7/field-evidence-hyperscale branch. We badge
 * it as `Rolling out Q3 2026` until it ships to GA.
 */

export type FeatureStatus = 'included' | 'addon' | 'unavailable' | 'roadmap';

export interface PricingFeature {
  label: string;
  starter: FeatureStatus | string;
  pro: FeatureStatus | string;
  enterprise: FeatureStatus | string;
  badge?: 'new' | 'q3-2026' | 'beta';
}

export interface PricingFeatureGroup {
  group: string;
  features: PricingFeature[];
}

export interface PricingTier {
  id: 'starter' | 'pro' | 'enterprise';
  name: string;
  tagline: string;
  price_monthly: string;
  price_caption: string;
  cta_label: string;
  cta_href: string;
  highlight?: boolean;
}

export const PRICING_TIERS: PricingTier[] = [
  {
    id: 'starter',
    name: 'Starter',
    tagline: 'Build, prototype, evaluate.',
    price_monthly: '$99',
    price_caption: 'per month, billed annually · 14-day free trial',
    cta_label: 'Start free trial',
    cta_href: '/signup',
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'Production SaaS for small + mid-market teams.',
    price_monthly: '$999',
    price_caption: 'per month, billed annually · everything in Starter plus production scale',
    cta_label: 'Start free trial',
    cta_href: '/signup',
    highlight: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Regulated industries, sovereign regions, custom SLAs.',
    price_monthly: 'Custom',
    price_caption: 'pricing scales with usage, compliance, and region',
    cta_label: 'Talk to sales',
    cta_href: 'mailto:sales@projexcloud.com',
  },
];

export const PRICING_FEATURES: PricingFeatureGroup[] = [
  {
    group: 'Scale',
    features: [
      { label: 'Platform API calls / month', starter: '250K',  pro: '5M',    enterprise: 'Unlimited (fair-use)' },
      { label: 'Tenants / Apps / Orgs',      starter: '1 / 1 / 3', pro: '1 / 5 / 25', enterprise: 'Unlimited' },
      { label: 'Personas (seats)',           starter: '10',    pro: '100',   enterprise: 'Unlimited' },
      { label: 'API keys',                   starter: '5',     pro: '50',    enterprise: 'Unlimited' },
      { label: 'Sandbox / dev environments', starter: '1',     pro: '3',     enterprise: 'Unlimited' },
    ],
  },
  {
    group: 'Identity & Access',
    features: [
      { label: 'Six-layer JWT (Master / App / Tenant / Persona / Encounter / Relationship)', starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'Social IdP (Google, Microsoft, Apple)', starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'SCIM 2.0 + SAML SP',                    starter: 'unavailable', pro: 'included', enterprise: 'included' },
      { label: 'MFA + step-up auth',                    starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'Impersonation grants (audit-tracked)',  starter: 'unavailable', pro: 'included', enterprise: 'included' },
    ],
  },
  {
    group: 'AI Gateway',
    features: [
      { label: 'AI Gateway (OpenAI, Anthropic, Bedrock, Gemini)', starter: 'Platform keys (markup)', pro: 'Platform keys (20% discount)', enterprise: 'At-cost + ops margin' },
      { label: 'BYOK for AI provider keys',                       starter: 'unavailable', pro: 'roadmap', enterprise: 'roadmap', badge: 'q3-2026' },
      { label: 'PII redaction + policy enforcement',              starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'Per-tenant routing rules',                        starter: 'unavailable', pro: 'included', enterprise: 'included' },
      { label: 'Langfuse trace integration',                      starter: 'addon', pro: 'included', enterprise: 'included' },
    ],
  },
  {
    group: 'Security & Compliance',
    features: [
      { label: 'Platform-managed encryption',              starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'BYOK / CMEK (AWS KMS, GCP KMS, HSM)',     starter: 'unavailable', pro: 'addon', enterprise: 'included' },
      { label: 'Audit ledger retention',                   starter: '30 days', pro: '1 year', enterprise: '7 years (configurable)' },
      { label: 'SOC 2 Type II (in progress)',              starter: 'Report on request', pro: 'Report on request', enterprise: 'Report on request' },
      { label: 'HIPAA BAA',                                starter: 'unavailable', pro: 'included', enterprise: 'included' },
      { label: 'FedRAMP-Moderate / StateRAMP (roadmap)',   starter: 'unavailable', pro: 'unavailable', enterprise: 'roadmap', badge: 'q3-2026' },
    ],
  },
  {
    group: 'Deployment',
    features: [
      { label: 'Single-region',                  starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'Active-Active multi-region',     starter: 'unavailable', pro: 'unavailable', enterprise: 'included' },
      { label: 'Sovereign regions (EU, UK, etc.)', starter: 'unavailable', pro: 'unavailable', enterprise: 'included' },
      { label: 'On-Prem / air-gapped',           starter: 'unavailable', pro: 'unavailable', enterprise: 'included' },
    ],
  },
  {
    group: 'Vertical packs',
    features: [
      { label: 'Vertical packs (Healthcare, FinServ, RevOps, Field-service, Public Sector)', starter: '1 pack', pro: '3 packs', enterprise: 'All + custom blueprints' },
      { label: 'AI-driven app builder (/build)', starter: 'included', pro: 'included', enterprise: 'included' },
      { label: 'CLI + MCP for local AI tools',  starter: 'included', pro: 'included', enterprise: 'included' },
    ],
  },
  {
    group: 'Support',
    features: [
      { label: 'Channels', starter: 'Community + email (48 hr)', pro: 'Email + Slack (8 hr business)', enterprise: 'Dedicated CSM + 24/7 phone' },
      { label: 'Uptime SLA',                              starter: 'Best-effort', pro: '99.9%', enterprise: '99.99% + custom MTTR' },
    ],
  },
];

export const PRICING_OVERAGE = [
  { label: 'Extra 100K platform API calls',    starter: '$20',   pro: '$10',   enterprise: 'Negotiated' },
  { label: 'Storage (GB / month)',             starter: '$0.50', pro: '$0.30', enterprise: '$0.15' },
  { label: 'Data egress (GB)',                 starter: '$0.15', pro: '$0.10', enterprise: '$0.05' },
  { label: 'Webhook deliveries (per 10K)',     starter: '$1',    pro: '$0.50', enterprise: '$0.25' },
];

export const PRICING_NOTES: string[] = [
  'All prices are in USD and exclude applicable taxes.',
  'Annual billing required for Starter and Pro tiers.',
  'AI provider tokens are billed separately as usage. On Starter and Pro this is platform-pass-through with a margin; Enterprise contracts negotiate the markup. BYOK for AI keys (the customer holds their own provider invoice) is on the Q3 2026 roadmap — see /security.',
  'Compliance attestations marked "in progress" or "roadmap" are forward-looking statements, not current certifications. Contact sales for the latest letter of attestation.',
];
