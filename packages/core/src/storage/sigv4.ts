import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for the three things this product does with object storage: hand a
 * browser a URL it can PUT to, read an object back to check it, and delete one.
 *
 * Written here rather than pulled in, deliberately. The AWS SDK is the obvious choice and would be
 * the right one if we were using S3 broadly - but this is presign-PUT, GET and DELETE against one
 * bucket, and the SDK brings roughly two hundred packages and twenty megabytes into two production
 * images to do it. SigV4 for these calls is HMAC-SHA256 over a canonical string, which is the same
 * primitive the visitor token already uses.
 *
 * The reason this is safe to hand-roll where a crypto primitive would not be: a wrong signature
 * fails loudly and immediately with `SignatureDoesNotMatch`. There is no quiet-wrongness mode. It
 * is verified against the real MinIO in `scripts/e2e-files.mjs`, not by inspection. See ADR-043.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/**
 * Percent-encode for a canonical URI.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, so those are finished off by hand.
 * Getting this wrong is the single most common way a hand-written signer fails, and it fails only
 * for the keys that happen to contain one of those characters - which is why our keys are uuids.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A key is a path: each segment is encoded, the separators are not. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, '')}`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(credentials: S3Credentials, dateStamp: string): Buffer {
  const date = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const region = hmac(date, credentials.region);
  const service = hmac(region, 's3');
  return hmac(service, 'aws4_request');
}

export interface PresignInput {
  method: 'PUT' | 'GET' | 'DELETE';
  /** The endpoint the *client* will call. Path-style for MinIO, virtual-host for real S3. */
  endpoint: string;
  bucket: string;
  key: string;
  credentials: S3Credentials;
  expiresInSeconds: number;
  forcePathStyle: boolean;
  now: Date;
  /** Extra query parameters, e.g. a response-content-disposition on a download. */
  query?: Record<string, string>;
}

/**
 * Build a URL that carries its own authorisation in the query string, and expires.
 *
 * Query-string signing rather than a header, because the point is to hand the URL to a browser -
 * which cannot set an Authorization header on a form upload or an `<img src>`.
 */
export function presignS3Url(input: PresignInput): string {
  const url = new URL(input.endpoint);
  const host = url.host;
  const basePath = url.pathname.replace(/\/+$/, '');

  const canonicalUri = input.forcePathStyle
    ? `${basePath}/${encodeRfc3986(input.bucket)}/${encodeKey(input.key)}`
    : `${basePath}/${encodeKey(input.key)}`;
  const requestHost = input.forcePathStyle ? host : `${input.bucket}.${host}`;

  const { amzDate, dateStamp } = stamps(input.now);
  const scope = `${dateStamp}/${input.credentials.region}/s3/aws4_request`;

  const parameters: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
    ...(input.query ?? {}),
  };

  // Canonical query strings are sorted by the *encoded* name, then the encoded value.
  const canonicalQuery = Object.keys(parameters)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(parameters[name] as string)}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    `host:${requestHost}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const origin = input.forcePathStyle
    ? `${url.protocol}//${host}`
    : `${url.protocol}//${input.bucket}.${host}`;
  return `${origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface SignedRequestInput extends Omit<PresignInput, 'expiresInSeconds' | 'query'> {
  /** The body of a PUT, so its hash can be signed rather than left unsigned. */
  body?: Buffer;
  /** Byte range for a GET, so verification can read a header without downloading a whole file. */
  range?: string;
}

/**
 * Sign a request this service makes itself, with an Authorization header.
 *
 * Used for the server-side half of an upload: reading the object back to find out what it actually
 * is, and deleting it when it turns out to be something we will not accept.
 */
export function signS3Request(input: SignedRequestInput): {
  url: string;
  headers: Record<string, string>;
} {
  const url = new URL(input.endpoint);
  const host = url.host;
  const basePath = url.pathname.replace(/\/+$/, '');

  const canonicalUri = input.forcePathStyle
    ? `${basePath}/${encodeRfc3986(input.bucket)}/${encodeKey(input.key)}`
    : `${basePath}/${encodeKey(input.key)}`;
  const requestHost = input.forcePathStyle ? host : `${input.bucket}.${host}`;

  const { amzDate, dateStamp } = stamps(input.now);
  const scope = `${dateStamp}/${input.credentials.region}/s3/aws4_request`;
  const payloadHash = input.body ? sha256(input.body) : sha256('');

  const headers: Record<string, string> = {
    host: requestHost,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(input.range ? { range: input.range } : {}),
  };

  const signedHeaderNames = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join('');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials, dateStamp))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const origin = input.forcePathStyle
    ? `${url.protocol}//${host}`
    : `${url.protocol}//${input.bucket}.${host}`;

  return {
    url: `${origin}${canonicalUri}`,
    headers: {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`,
    },
  };
}
