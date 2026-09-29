/**
 * @projexlight/connector-telnyx-voice — Telnyx as a voice-agent carrier (VA·E6).
 *
 * Provisions a tenant's Telnyx SIP connection to the platform's LiveKit SIP service (the
 * 'telnyx' CarrierProvisioner for sdk-voice-agent's trunk flow) and mirrors Telnyx call legs
 * (connector_telnyx_voice.voice_call). Outbound AI calls are originated by sdk-voice-agent
 * over the LiveKit outbound trunk this creates. See VoiceAgent-Architecture-v3.1.html §8.
 */
export { migrationsDir } from './db';

export { telnyxProvisioner, sipHost, TELNYX_SIP_HOST } from './services/telnyxProvisioner';
