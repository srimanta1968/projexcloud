/**
 * @projexlight/sdk-voice-agent — control plane for multi-tenant BYOK voice agents (VA·E2).
 *
 * Owns stack profiles (cloned from presets), agents and their immutable versions,
 * number bindings, app-registered tools, AI call records and turn transcripts.
 * The real-time media runtime lives in services/voice-runtime and reads this
 * control plane once per call; see docs/v3.1/voiceagent/VoiceAgent-Architecture-v3.1.html.
 */
export { migrationsDir } from './db';
