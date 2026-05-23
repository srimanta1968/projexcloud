// Requires AWS credentials via standard AWS SDK chain (env vars, instance
// profile, IRSA). Set NOTIFICATION_FROM_EMAIL / AWS_REGION to enable boot-time
// registration.
//
// Real AWS S3 Sig-V4 presigner backing the S3Signer contract from
// blobService.ts. Replaces the synthetic SHA-256-stamped URL signer. Uses
// @aws-sdk/s3-request-presigner for proper Sig-V4 query-string signing so
// the resulting URLs are accepted by real S3 buckets.

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { registerS3Signer, type S3Signer, type S3SignerArgs } from './blobService';

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const region = process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  // Default credential chain (IRSA / EC2 instance role / shared config) when
  // explicit keys are not provided.
  cachedClient =
    accessKeyId && secretAccessKey
      ? new S3Client({ region, credentials: { accessKeyId, secretAccessKey } })
      : new S3Client({ region });
  return cachedClient;
}

export const awsSigV4Signer: S3Signer = async (args: S3SignerArgs): Promise<string> => {
  const client = getClient();
  const command =
    args.method === 'PUT'
      ? new PutObjectCommand({ Bucket: args.bucket, Key: args.key })
      : new GetObjectCommand({ Bucket: args.bucket, Key: args.key });
  return getSignedUrl(client, command, { expiresIn: args.ttl_seconds });
};

/**
 * Wires the real Sig-V4 presigner into sdk-media. Only registers when
 * AWS_REGION is set (always set even in dev, so this typically returns true
 * outside of tests).
 */
export function registerAwsS3Signer(): boolean {
  if (!process.env.AWS_REGION) return false;
  registerS3Signer(awsSigV4Signer);
  return true;
}
