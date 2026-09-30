import Link from 'next/link';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../lib/gateway';
import { addKeyAction, validateKeyAction } from './actions';

/**
 * Voice key vault and presets (VA·E9 · TK-4512).
 *
 * BYOK voice stacks: the tenant brings a key per layer (LLM, speech-to-text, text-to-speech,
 * realtime, telephony). Each key is validated against its provider, which also reports the
 * max SAFE concurrency — the dialer never runs more simultaneous calls on a key than that.
 * Below, the preset stacks with their live estimated $/min and whether the tenant has the
 * validated keys each one needs.
 *
 * Raw keys are submitted via a password input and never rendered back: the gateway returns
 * only last_4 and lifecycle metadata.
 */

type Layer = 'llm' | 'stt' | 'tts' | 'realtime' | 'telephony';

const LAYERS: { id: Layer; label: string }[] = [
  { id: 'llm', label: 'Language model (LLM)' },
  { id: 'stt', label: 'Speech-to-text (STT)' },
  { id: 'tts', label: 'Text-to-speech (TTS)' },
  { id: 'realtime', label: 'Realtime speech-to-speech' },
  { id: 'telephony', label: 'Telephony' },
];

/** Mirrors sdk-ai-gateway LAYER_PROVIDERS; the gateway re-validates the pairing. */
const LAYER_PROVIDERS: Record<Layer, string[]> = {
  llm: ['anthropic', 'openai', 'bedrock', 'gemini', 'groq', 'cerebras', 'together', 'fireworks', 'deepinfra', 'mistral', 'xai'],
  stt: ['deepgram', 'assemblyai', 'openai'],
  tts: ['cartesia', 'elevenlabs', 'deepgram', 'openai'],
  realtime: ['openai', 'gemini', 'bedrock'],
  telephony: ['twilio', 'telnyx'],
};

interface Binding {
  binding_id: string;
  provider_id: string;
  layer: Layer;
  priority: 'primary' | 'secondary';
  status: 'active' | 'revoked';
  validation_status: string;
  rate_limit_tier: string | null;
  max_concurrency: number | null;
  validated_at: string | null;
  validation_error: string | null;
  last_4: string;
}

interface Preset {
  key: string;
  name: string;
  required_credential_layers: string[];
  estimated_cost_per_min: { low: number; high: number };
  available: boolean;
}

async function load(): Promise<{ bindings: Binding[]; presets: Preset[]; error?: string }> {
  try {
    const [creds, presets] = await Promise.all([
      gateway.get<{ bindings: Binding[] }>('/api/ai-gateway/tenant-credentials'),
      gateway.get<{ presets: Preset[] }>('/api/voice-agent/presets'),
    ]);
    return { bindings: creds.bindings.filter((b) => b.status === 'active'), presets: presets.presets };
  } catch (err) {
    return { bindings: [], presets: [], error: err instanceof GatewayError ? err.message : 'Could not load keys' };
  }
}

function ValidationBadge({ b }: { b: Binding }) {
  const variant: 'success' | 'secondary' | 'destructive' = b.validation_status === 'ok' ? 'success' : b.validation_status === 'unvalidated' ? 'secondary' : 'destructive';
  const label = b.validation_status === 'ok' ? 'Valid' : b.validation_status === 'unvalidated' ? 'Not validated' : b.validation_status.replace(/_/g, ' ');
  return <Badge variant={variant} data-testid={`key-status-${b.binding_id}`}>{label}</Badge>;
}

const money = (n: number) => `$${n.toFixed(3)}`;

/**
 * A preset names stack SLOTS (telephony, stt, llm_fast, llm_complex, tts); both LLM slots run
 * on the tenant's llm key, so the keys a preset needs are the distinct credential layers.
 */
function credentialLayersOf(p: Preset): Layer[] {
  const layers = p.required_credential_layers.map((slot) => (slot.startsWith('llm') ? 'llm' : slot) as Layer);
  return [...new Set(layers)];
}

export default async function VoiceKeysPage({ searchParams }: { searchParams: { error?: string; added?: string; validated?: string; status?: string; preset?: string } }) {
  const { bindings, presets, error } = await load();
  const validLayers = new Set(bindings.filter((b) => b.validation_status === 'ok').map((b) => b.layer));
  const chosen = presets.find((p) => p.key === searchParams.preset) ?? presets[0];

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Voice keys &amp; presets</h1>
        <p className="text-muted-foreground">
          Bring your own key for each layer of a voice stack. Validating a key checks it with the provider and records how many
          calls it can safely carry at once.
        </p>
      </div>

      {error || searchParams.error ? <Alert variant="destructive" data-testid="voice-keys-error">{error ?? searchParams.error}</Alert> : null}
      {searchParams.added ? <Alert variant="success" data-testid="voice-keys-added">Key saved. Validate it to see its safe concurrency.</Alert> : null}
      {searchParams.validated ? (
        <Alert variant={searchParams.status === 'ok' ? 'success' : 'warning'} data-testid="voice-keys-validated">
          Validation result: {searchParams.status === 'ok' ? 'valid' : (searchParams.status ?? '').replace(/_/g, ' ')}
        </Alert>
      ) : null}

      <Card className="grid gap-4 p-4">
        <h2 className="text-lg font-semibold">Add a key</h2>
        <form action={addKeyAction} className="grid gap-3 md:grid-cols-4 md:items-end">
          <Field label="Layer" htmlFor="layer">
            <Select id="layer" name="layer" defaultValue="llm" required>
              {LAYERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </Select>
          </Field>
          <Field label="Provider" htmlFor="provider_id" hint="Must support the chosen layer">
            <Select id="provider_id" name="provider_id" required>
              {LAYERS.map((l) => (
                <optgroup key={l.id} label={l.label}>
                  {LAYER_PROVIDERS[l.id].map((p) => <option key={`${l.id}-${p}`} value={p}>{p}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Priority" htmlFor="priority">
            <Select id="priority" name="priority" defaultValue="primary">
              <option value="primary">primary</option>
              <option value="secondary">secondary (failover)</option>
            </Select>
          </Field>
          <Field label="API key" htmlFor="raw_key">
            <Input id="raw_key" name="raw_key" type="password" autoComplete="off" minLength={8} required placeholder="API key" />
          </Field>
          <Button type="submit" data-testid="voice-keys-add">Save key</Button>
        </form>
      </Card>

      {LAYERS.map((l) => {
        const rows = bindings.filter((b) => b.layer === l.id);
        return (
          <Card key={l.id} className="grid gap-3 p-4" data-testid={`voice-keys-layer-${l.id}`}>
            <h2 className="text-lg font-semibold">{l.label}</h2>
            {rows.length === 0 ? (
              <p className="text-muted-foreground">No key for this layer.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Safe concurrency</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((b) => (
                    <TableRow key={b.binding_id}>
                      <TableCell>{b.provider_id}</TableCell>
                      <TableCell>{b.priority}</TableCell>
                      <TableCell>••••{b.last_4}</TableCell>
                      <TableCell>
                        <ValidationBadge b={b} />
                        {b.validation_error ? <div className="text-xs text-muted-foreground">{b.validation_error}</div> : null}
                      </TableCell>
                      <TableCell data-testid={`key-concurrency-${b.binding_id}`}>
                        {b.max_concurrency !== null ? `${b.max_concurrency} calls` : b.validation_status === 'ok' ? 'Not reported by provider' : '—'}
                        {b.rate_limit_tier ? <div className="text-xs text-muted-foreground">tier {b.rate_limit_tier}</div> : null}
                      </TableCell>
                      <TableCell>
                        <form action={validateKeyAction}>
                          <input type="hidden" name="binding_id" value={b.binding_id} />
                          <Button type="submit" variant="secondary" size="sm">Validate</Button>
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        );
      })}

      <Card className="grid gap-4 p-4" data-testid="voice-presets">
        <h2 className="text-lg font-semibold">Preset stacks</h2>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Link
              key={p.key}
              href={`/voice/keys?preset=${encodeURIComponent(p.key)}`}
              className={`rounded-md border px-3 py-2 ${chosen?.key === p.key ? 'border-foreground font-semibold' : 'border-input'}`}
              data-testid={`preset-${p.key}`}
            >
              {p.name}
              <span className="ml-2 text-muted-foreground">
                {money(p.estimated_cost_per_min.low)}–{money(p.estimated_cost_per_min.high)}/min
              </span>
            </Link>
          ))}
        </div>
        {chosen ? (
          <div className="grid gap-2" data-testid="preset-detail">
            <div>
              <strong>{chosen.name}</strong>: estimated {money(chosen.estimated_cost_per_min.low)}–{money(chosen.estimated_cost_per_min.high)} per
              minute in provider charges (billed to your keys), before the platform fee.
            </div>
            <ul className="grid gap-1">
              {credentialLayersOf(chosen).map((layer) => (
                <li key={layer}>
                  {validLayers.has(layer as Layer) ? '✓' : '✗'} {LAYERS.find((l) => l.id === layer)?.label ?? layer}
                  {validLayers.has(layer as Layer) ? '' : ' — add and validate a key'}
                </li>
              ))}
            </ul>
            {!chosen.available ? <Alert variant="warning">This preset includes an uncertified component and cannot be used for new agents.</Alert> : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
