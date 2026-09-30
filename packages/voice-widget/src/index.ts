/**
 * @projexlight/voice-widget (VA·E9 · TK-4511) — the embeddable TalkToAgent widget and its
 * headless hook. The host starts the test session on its own backend (so the tenant
 * credential never reaches the browser) and hands the widget { call_id, livekit_url, token }.
 */
export { TalkToAgent } from './TalkToAgent';
export type { TalkToAgentProps } from './TalkToAgent';
export { useTalkToAgent } from './useTalkToAgent';
export type { TalkSession, StartSession, TalkToAgentControls } from './useTalkToAgent';
export { widgetReducer, initialWidgetState, statusLabel, micErrorEvent } from './state';
export type { WidgetState, WidgetStatus, WidgetEvent } from './state';
