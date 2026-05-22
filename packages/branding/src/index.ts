import * as React from 'react';

export interface BrandConfig {
  tenant_id: string;
  brand_name: string;
  cname_host: string | null;
  logo_url: string | null;
  primary_color: string;
  accent_color: string;
}

const DEFAULT_BRAND: BrandConfig = {
  tenant_id: '',
  brand_name: 'ProjexCloud',
  cname_host: null,
  logo_url: null,
  primary_color: '#c9a86a',
  accent_color: '#6aa9ff',
};

const _byDomain: Record<string, BrandConfig> = {};

export function registerBrand(domain: string, brand: BrandConfig): void {
  _byDomain[domain] = brand;
}

/**
 * Resolves the active brand for a given request domain. Falls back to platform
 * defaults when no override is registered. Production wires this up by
 * reading `tenant.tenant.brand_domain` and seeding `_byDomain` at boot.
 */
export function resolveBrand(domain: string): BrandConfig {
  return _byDomain[domain] ?? DEFAULT_BRAND;
}

const BrandingContext = React.createContext<BrandConfig>(DEFAULT_BRAND);

export interface BrandingProviderProps {
  brand: BrandConfig;
  children?: React.ReactNode;
}

/**
 * <BrandingProvider> emits CSS variables on a wrapping div so the design
 * system tokens pick up the brand's primary/accent colors automatically.
 */
export function BrandingProvider(props: BrandingProviderProps): React.JSX.Element {
  const style: React.CSSProperties = {
    // CSS custom properties consumed by design-system tokens
    ['--pl-primary' as never]: props.brand.primary_color,
    ['--pl-accent' as never]: props.brand.accent_color,
  };
  return React.createElement(
    BrandingContext.Provider,
    { value: props.brand },
    React.createElement('div', { style }, props.children),
  );
}

export function useBrand(): BrandConfig {
  return React.useContext(BrandingContext);
}
