import { describe, it, expect } from 'vitest';
import { recordMeasurement } from '../src/services/measurementService';

/**
 * Input-validation paths run before the SQL pathway, so we can exercise
 * them without a live database. Anything that requires `dataService.one`
 * to actually fire is covered by the integration suite in api-gateway
 * (DB-guarded, skips when DB_HOST is unset).
 */
describe('hdk-measure recordMeasurement — input validation', () => {
  const base = {
    capture_id: 'cap_1',
    kind: 'distance' as const,
    value: 1.0,
    unit: 'm',
    device_uuid: '00000000-0000-0000-0000-000000000001',
  };

  it('rejects missing capture_id', async () => {
    await expect(recordMeasurement({ ...base, capture_id: '' })).rejects.toThrow(/capture_id/);
  });

  it('rejects missing device_uuid', async () => {
    await expect(recordMeasurement({ ...base, device_uuid: '' })).rejects.toThrow(/device_uuid/);
  });

  it('rejects blank unit', async () => {
    await expect(recordMeasurement({ ...base, unit: '   ' })).rejects.toThrow(/unit/);
  });

  it('rejects non-finite value', async () => {
    await expect(recordMeasurement({ ...base, value: Number.NaN })).rejects.toThrow(/finite/);
    await expect(recordMeasurement({ ...base, value: Number.POSITIVE_INFINITY })).rejects.toThrow(/finite/);
  });

  it('rejects negative value', async () => {
    await expect(recordMeasurement({ ...base, value: -0.01 })).rejects.toThrow(/non-negative/);
  });

  it('rejects invalid measurement kind', async () => {
    await expect(
      recordMeasurement({ ...base, kind: 'weight' as unknown as 'distance' }),
    ).rejects.toThrow(/invalid kind/);
  });

  it('rejects malformed captured_at', async () => {
    await expect(
      recordMeasurement({ ...base, captured_at: 'not-a-date' }),
    ).rejects.toThrow(/captured_at/);
  });
});
