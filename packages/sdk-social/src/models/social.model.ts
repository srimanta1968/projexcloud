export type SocialNetwork = 'twitter' | 'linkedin' | 'instagram' | 'facebook' | 'tiktok';
export type InteractionKind = 'dm' | 'comment' | 'mention' | 'review';

export interface HandleRecord {
  handle_id: string;
  tenant_id: string;
  network: SocialNetwork;
  external_handle_id: string;
  authorized_persona_id: string;
  authorized_at: Date;
}

export interface InteractionRecord {
  interaction_id: string;
  handle_id: string;
  kind: InteractionKind;
  author_external_id: string;
  author_persona_id: string | null;
  body: string | null;
  received_at: Date;
  captured_lead_contact_id: string | null;
}

export interface AuthorizeHandleInput {
  tenant_id: string;
  network: SocialNetwork;
  external_handle_id: string;
  authorized_persona_id: string;
}

export interface IngestInteractionInput {
  handle_id: string;
  kind: InteractionKind;
  author_external_id: string;
  author_persona_id?: string;
  body?: string;
}
