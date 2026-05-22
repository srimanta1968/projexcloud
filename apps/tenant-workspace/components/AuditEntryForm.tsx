'use client';

import { FormEvent, useState } from 'react';
import { AuditEntry, appendAuditEntry } from '../services/auditApi';

export interface AuditEntryFormProps {
  onAppended?: (entry: AuditEntry) => void;
}

/**
 * Form that posts a new audit ledger entry. Caller chooses event_type and a
 * free-form JSON payload; the form parses the JSON before submission.
 */
export default function AuditEntryForm({ onAppended }: AuditEntryFormProps): JSX.Element {
  const [eventType, setEventType] = useState('test.event');
  const [payloadText, setPayloadText] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    let payload: unknown;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      setError('Payload must be valid JSON.');
      return;
    }

    setSubmitting(true);
    try {
      const entry = await appendAuditEntry({ event_type: eventType.trim(), payload });
      if (onAppended) onAppended(entry);
      setPayloadText('{}');
    } catch (err) {
      const e = err as { error?: string; details?: string[] };
      setError(e.details?.join(', ') || e.error || 'Append failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Append audit entry">
      <div>
        <label htmlFor="audit-event-type">Event type</label>
        <input
          id="audit-event-type"
          type="text"
          value={eventType}
          onChange={(e) => setEventType(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="audit-payload">Payload (JSON)</label>
        <textarea
          id="audit-payload"
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
          rows={5}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Appending...' : 'Append entry'}
      </button>
    </form>
  );
}
