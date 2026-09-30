/**
 * Opening disclosures (VA·E1 · TK-4461).
 *
 * Every call opens with a statement that the caller is talking to an AI, spoken by the
 * runtime BEFORE the agent's greeting. The text is the platform's, not the tenant's: no
 * prompt, greeting or agent setting can remove or reword it, and barge-in does not cut it
 * short. When the call may be recorded (bootstrap `recording.notice`), the recording notice
 * follows in the same breath; otherwise it is never said.
 *
 * Keyed by the agent's language (base code: "es-MX" -> "es"); unknown languages use English.
 */

const AI_DISCLOSURE: Record<string, string> = {
  en: "Hi, just so you know, you're speaking with an AI assistant.",
  es: 'Hola, le informamos que está hablando con un asistente de inteligencia artificial.',
  fr: "Bonjour, sachez que vous parlez avec un assistant d'intelligence artificielle.",
  de: 'Hallo, zu Ihrer Information: Sie sprechen mit einem KI-Assistenten.',
  pt: 'Olá, informamos que você está falando com um assistente de inteligência artificial.',
  it: 'Salve, la informiamo che sta parlando con un assistente di intelligenza artificiale.',
  nl: 'Hallo, u spreekt met een AI-assistent.',
};

const RECORDING_NOTICE: Record<string, string> = {
  en: 'This call may be recorded.',
  es: 'Esta llamada puede ser grabada.',
  fr: 'Cet appel peut être enregistré.',
  de: 'Dieses Gespräch kann aufgezeichnet werden.',
  pt: 'Esta chamada pode ser gravada.',
  it: 'Questa chiamata potrebbe essere registrata.',
  nl: 'Dit gesprek kan worden opgenomen.',
};

export function baseLanguage(language: string | undefined): string {
  const b = String(language || 'en').toLowerCase().split(/[-_]/)[0];
  return AI_DISCLOSURE[b] ? b : 'en';
}

/** The mandatory opening: the AI disclosure, plus the recording notice when recording is permitted. */
export function openingDisclosure(language: string | undefined, recordingNotice: boolean): string {
  const l = baseLanguage(language);
  return recordingNotice ? `${AI_DISCLOSURE[l]} ${RECORDING_NOTICE[l]}` : AI_DISCLOSURE[l];
}
