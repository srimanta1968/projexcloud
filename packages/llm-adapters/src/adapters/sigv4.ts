import crypto from 'crypto';

/**
 * AWS Signature Version 4 request signing (for the Bedrock adapter, VA·E5 · TK-4494).
 * Implements the header-based signing flow from the AWS SigV4 specification; verified
 * against AWS's published get-vanilla test vector.
 */

export interface AwsCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

const sha256Hex = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires (encodes everything except A-Z a-z 0-9 - _ . ~). */
export function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Override the signing time (tests). */
  now?: Date;
}

/**
 * Returns the headers to send: the input headers plus host, x-amz-date, optional
 * x-amz-security-token, and Authorization.
 */
export function signV4(input: SignInput): Record<string, string> {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = { ...input.headers, host: input.url.host, 'x-amz-date': amzDate };
  if (input.credentials.session_token) headers['x-amz-security-token'] = input.credentials.session_token;

  const lower = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const);
  lower.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lower.map(([k]) => k).join(';');

  // Non-S3 services: each path segment is URI-encoded twice in the canonical request (the
  // URL already carries it encoded once, so decode then encode twice).
  const canonicalUri = input.url.pathname
    .split('/')
    .map((seg) => awsUriEncode(awsUriEncode(decodeURIComponent(seg))))
    .join('/') || '/';
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [input.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, sha256Hex(input.body)].join('\n');
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secret_access_key}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.access_key_id}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
