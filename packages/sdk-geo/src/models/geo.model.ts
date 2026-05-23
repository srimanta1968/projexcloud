/**
 * Models mirroring geo.* tables per P3-Canonical-Privacy-HDK-DataModel §8.1.
 */

export interface AddressRecord {
  address_id: string;
  street: string;
  city: string;
  region: string | null;
  postal_code: string | null;
  country: string;
  lat: number | null;
  lng: number | null;
  geo_node_id: string | null;
  provider_refs: Record<string, string>;
  created_at: Date;
}

export interface AddressAliasRecord {
  alias_id: string;
  address_id: string;
  raw_input: string;
  hash: Buffer;
}

export interface MergeEventRecord {
  merge_id: string;
  winner_address_id: string;
  loser_address_id: string;
  occurred_at: Date;
  operator_id: string | null;
}

export interface CanonicalizeInput {
  raw_input: string;
  street: string;
  city: string;
  country: string;
  region?: string;
  postal_code?: string;
  lat?: number;
  lng?: number;
  geo_node_id?: string;
  provider_refs?: Record<string, string>;
}

export interface BboxQueryInput {
  min_lat: number;
  min_lng: number;
  max_lat: number;
  max_lng: number;
  limit?: number;
}

export interface GeocodeProvider {
  name: 'mapbox' | 'google' | 'osm' | 'noop';
  geocode(raw_input: string): Promise<Pick<CanonicalizeInput, 'lat' | 'lng' | 'provider_refs' | 'region' | 'postal_code'> | null>;
  reverseGeocode(lat: number, lng: number): Promise<{ street: string; city: string; country: string } | null>;
}
