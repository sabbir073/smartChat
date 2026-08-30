import { createHash } from 'node:crypto';
import { presignS3Url, signS3Request, type S3Credentials } from './sigv4.js';
import { systemClock, type Clock } from '../time.js';

export interface StorageOptions {
  /** Where this service reaches the store. Inside Docker that is the container name. */
  endpoint: string;
  /** Where a *browser* reaches the store. Different host, same bucket. */
  publicEndpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

export interface StoredObject {
  bytes: Buffer;
  byteSize: number;
  checksum: string;
}

/**
 * Object storage, as this product uses it.
 *
 * Four operations and nothing else: sign a URL a browser can upload to, read an object back, hand
 * out a short-lived download URL, and delete. Everything about *what* may be stored is decided
 * elsewhere - this layer moves bytes and has no opinions.
 */
export class StorageService {
  private readonly clock: Clock;
  private readonly credentials: S3Credentials;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: StorageOptions) {
    this.clock = options.clock ?? systemClock;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.credentials = {
      accessKeyId: options.accessKey,
      secretAccessKey: options.secretKey,
      region: options.region,
    };
  }

  /**
   * A URL the client can PUT to, and nothing else.
   *
   * It authorises one method, on one key, for a few minutes. It cannot be used to read anything,
   * to write anywhere else, or to list the bucket - so handing it to a visitor's browser on
   * somebody else's website gives that page no reach beyond the single object we chose for it.
   */
  signUpload(key: string, expiresInSeconds = 300): string {
    return presignS3Url({
      method: 'PUT',
      endpoint: this.options.publicEndpoint,
      bucket: this.options.bucket,
      key,
      credentials: this.credentials,
      expiresInSeconds,
      forcePathStyle: this.options.forcePathStyle,
      now: this.clock.now(),
    });
  }

  /**
   * A short-lived URL for reading one object.
   *
   * Short-lived on purpose: a download link that never expires is a public file with extra steps,
   * and these are somebody's support attachments. The download name and type are pinned into the
   * URL so the store cannot be talked into serving the object as something else.
   */
  signDownload(
    key: string,
    options: { fileName: string; contentType: string; expiresInSeconds?: number },
  ): string {
    return presignS3Url({
      method: 'GET',
      endpoint: this.options.publicEndpoint,
      bucket: this.options.bucket,
      key,
      credentials: this.credentials,
      expiresInSeconds: options.expiresInSeconds ?? 600,
      forcePathStyle: this.options.forcePathStyle,
      now: this.clock.now(),
      query: {
        'response-content-type': options.contentType,
        // `attachment` unless it is something we are confident rendering inline. A stored file is
        // never served as a document the browser will execute in our origin.
        'response-content-disposition': `${
          options.contentType.startsWith('image/') ? 'inline' : 'attachment'
        }; filename="${options.fileName.replace(/"/g, '')}"`,
      },
    });
  }

  /** Read an object back. Returns null when it is not there. */
  async read(key: string, maxBytes: number): Promise<StoredObject | null> {
    const signed = signS3Request({
      method: 'GET',
      endpoint: this.options.endpoint,
      bucket: this.options.bucket,
      key,
      credentials: this.credentials,
      forcePathStyle: this.options.forcePathStyle,
      now: this.clock.now(),
    });

    const response = await this.fetchImpl(signed.url, { headers: signed.headers });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`object store returned ${response.status} reading an object`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    // The signed PUT carried a size limit as a promise, not as a guarantee: the store enforces
    // nothing on our behalf. This is where an object that grew past the limit is caught.
    if (bytes.byteLength > maxBytes) {
      return { bytes: bytes.subarray(0, maxBytes), byteSize: bytes.byteLength, checksum: '' };
    }
    return {
      bytes,
      byteSize: bytes.byteLength,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  async delete(key: string): Promise<void> {
    const signed = signS3Request({
      method: 'DELETE',
      endpoint: this.options.endpoint,
      bucket: this.options.bucket,
      key,
      credentials: this.credentials,
      forcePathStyle: this.options.forcePathStyle,
      now: this.clock.now(),
    });
    const response = await this.fetchImpl(signed.url, {
      method: 'DELETE',
      headers: signed.headers,
    });
    // 204 on success, 404 when it was never there. Neither is a problem for a caller who is
    // cleaning up after a rejected upload.
    if (!response.ok && response.status !== 404) {
      throw new Error(`object store returned ${response.status} deleting an object`);
    }
  }

  get bucketName(): string {
    return this.options.bucket;
  }
}
