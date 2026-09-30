'use client';

import { useState, useTransition } from 'react';
import { Alert, Button, Field, Input, Select } from '@projexlight/design-system';
import { previewVoiceAction } from '../actions';

/** Hear a voice with one of the tenant's own TTS keys before building it into a stack. */
export function VoicePreview({ ttsKeys }: { ttsKeys: { binding_id: string; label: string }[] }) {
  const [bindingId, setBindingId] = useState(ttsKeys[0]?.binding_id ?? '');
  const [text, setText] = useState('Hi, thanks for calling. How can I help you today?');
  const [voice, setVoice] = useState('');
  const [audio, setAudio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (ttsKeys.length === 0) {
    return <p className="text-muted-foreground" data-testid="voice-preview-nokey">Add and validate a text-to-speech key under Voice keys to preview voices.</p>;
  }
  const run = () => start(async () => {
    setError(null);
    setAudio(null);
    const r = await previewVoiceAction({ binding_id: bindingId, text, voice: voice || undefined });
    if (r.ok && r.audio_src) setAudio(r.audio_src);
    else setError(r.error ?? 'Preview failed');
  });

  return (
    <div className="grid gap-3" data-testid="voice-preview">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="TTS key" htmlFor="preview_binding">
          <Select id="preview_binding" value={bindingId} onChange={(e) => setBindingId(e.target.value)}>
            {ttsKeys.map((k) => <option key={k.binding_id} value={k.binding_id}>{k.label}</option>)}
          </Select>
        </Field>
        <Field label="Voice (optional)" htmlFor="preview_voice">
          <Input id="preview_voice" value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="provider voice id" />
        </Field>
      </div>
      <Field label="Sample text" htmlFor="preview_text">
        <Input id="preview_text" value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div>
        <Button type="button" onClick={run} disabled={pending || !text.trim()} data-testid="voice-preview-play">
          {pending ? 'Generating…' : 'Preview voice'}
        </Button>
      </div>
      {error ? <Alert variant="destructive" data-testid="voice-preview-error">{error}</Alert> : null}
      {audio ? <audio controls autoPlay src={audio} data-testid="voice-preview-audio" /> : null}
    </div>
  );
}
