// OC-12 known-bad fixture: provisions a cloud resource but never registers it
// in the resource ownership registry (no registerResource / resource_registry).
// The OC-12 rule must flag this.

declare const s3: { createBucket(name: string): Promise<{ id: string }> };

export async function provisionBucket(name: string): Promise<string> {
  // BUG: provisions infra with no owner/registry row.
  const bucket = await s3.createBucket(name);
  return bucket.id;
}
