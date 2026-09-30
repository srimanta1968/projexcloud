import { retrieveSecret, storeSecret } from '@projexlight/sdk-secrets';

/**
 * The BYOK key-wrapping secret ref (tenant provider keys are envelope-encrypted under it).
 *
 * The sdk-secrets ref catalog lives in process memory, so the ref must be registered in EVERY
 * process before it can ENCRYPT or DECRYPT. It used to be registered only on the bind path:
 * after a restart, decrypting an existing tenant key failed ("Secret reference not
 * registered") until someone bound a new key in that process — every BYOK completion and
 * voice-call bootstrap in between broke. Both paths now call ensureVaultRef() first.
 */
export const VAULT_REF = process.env.AI_GATEWAY_BYOK_VAULT_REF || 'secret://pool/ai-gateway-tenant-byok';
const VAULT_KMS_KEY_ID = process.env.AI_GATEWAY_BYOK_KMS_KEY_ID || 'ai-gateway-tenant-byok';

let ready = false;
export async function ensureVaultRef(): Promise<void> {
  if (ready) return;
  if (!(await retrieveSecret(VAULT_REF))) {
    await storeSecret({ ref: VAULT_REF, scope: 'pool', kms_key_id: VAULT_KMS_KEY_ID });
  }
  ready = true;
}
