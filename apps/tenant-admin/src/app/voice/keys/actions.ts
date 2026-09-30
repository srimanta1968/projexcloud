'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { gateway, GatewayError } from '../../../lib/gateway';

const back = (params: Record<string, string>): never => redirect(`/voice/keys?${new URLSearchParams(params).toString()}`);

/** Binds a provider key for a voice layer. The raw key goes straight to the gateway and is never re-rendered. */
export async function addKeyAction(form: FormData): Promise<void> {
  const layer = String(form.get('layer') ?? '');
  const provider_id = String(form.get('provider_id') ?? '');
  const priority = String(form.get('priority') ?? 'primary');
  const raw_key = String(form.get('raw_key') ?? '');
  let bindingId = '';
  try {
    const { binding } = await gateway.post<{ binding: { binding_id: string } }>('/api/ai-gateway/tenant-credentials', { layer, provider_id, priority, raw_key });
    bindingId = binding.binding_id;
  } catch (err) {
    back({ error: err instanceof GatewayError ? err.message : 'Could not save the key' });
  }
  revalidatePath('/voice/keys');
  back({ added: bindingId });
}

/** Probes the key with its provider: validity, rate-limit tier and the max safe concurrency. */
export async function validateKeyAction(form: FormData): Promise<void> {
  const bindingId = String(form.get('binding_id') ?? '');
  let status = '';
  try {
    const { validation } = await gateway.post<{ validation: { status: string } }>(`/api/speech/credentials/${encodeURIComponent(bindingId)}/validate`, {});
    status = validation.status;
  } catch (err) {
    back({ error: err instanceof GatewayError ? err.message : 'Could not validate the key' });
  }
  revalidatePath('/voice/keys');
  back({ validated: bindingId, status });
}
