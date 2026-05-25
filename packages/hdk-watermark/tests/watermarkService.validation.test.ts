import { describe, it, expect } from 'vitest';
import { recordWatermarkApplication } from '../src/services/watermarkService';

describe('hdk-watermark recordWatermarkApplication — input validation', () => {
  const base = {
    variant_id: 'var_1',
    scheme: 'visible' as const,
    payload_envelope: Buffer.from('{"merkle_leaf":"abc"}', 'utf8'),
  };

  it('rejects missing variant_id', async () => {
    await expect(
      recordWatermarkApplication({ ...base, variant_id: '' }),
    ).rejects.toThrow(/variant_id/);
  });

  it('rejects invalid scheme', async () => {
    await expect(
      recordWatermarkApplication({
        ...base,
        scheme: 'metallic' as unknown as 'visible',
      }),
    ).rejects.toThrow(/invalid scheme/);
  });

  it('rejects missing payload_envelope', async () => {
    await expect(
      recordWatermarkApplication({
        ...base,
        payload_envelope: undefined as unknown as Buffer,
      }),
    ).rejects.toThrow(/payload_envelope/);
  });

  it('rejects empty payload_envelope', async () => {
    await expect(
      recordWatermarkApplication({ ...base, payload_envelope: Buffer.alloc(0) }),
    ).rejects.toThrow(/empty/);
  });

  it('rejects oversize payload_envelope', async () => {
    const oversize = Buffer.alloc(64 * 1024); // 64KB > 16KB default cap
    await expect(
      recordWatermarkApplication({ ...base, payload_envelope: oversize }),
    ).rejects.toThrow(/exceeds limit/);
  });
});
