export type DevicePlatform = 'ios' | 'android' | 'web' | 'desktop';
export type DeviceStatus = 'active' | 'revoked' | 'stolen';
export type AttestationMethod = 'secure-enclave' | 'key-attestation' | 'safetynet' | 'play-integrity';
export type PersonLinkStatus = 'active' | 'suspended' | 'revoked';

export interface DeviceRecord {
  device_uuid: string;
  device_key_ref: string | null;
  platform: DevicePlatform;
  os_version: string | null;
  app_version: string | null;
  status: DeviceStatus;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface AttestationRecord {
  attestation_id: string;
  device_uuid: string;
  method: AttestationMethod;
  signature_envelope: Buffer;
  occurred_at: Date;
  expires_at: Date | null;
  verified: boolean;
}

export interface PersonLinkRecord {
  link_id: string;
  device_uuid: string;
  person_id: string;
  first_used_at: Date;
  last_used_at: Date;
  status: PersonLinkStatus;
}

export interface RegisterDeviceInput {
  device_uuid: string;
  platform: DevicePlatform;
  os_version?: string;
  app_version?: string;
  device_key_ref?: string;
}

export interface AttestDeviceInput {
  device_uuid: string;
  method: AttestationMethod;
  signature_envelope: Buffer | string;
  expires_at?: string;
  verified?: boolean;
}

export interface LinkPersonInput {
  device_uuid: string;
  person_id: string;
}
