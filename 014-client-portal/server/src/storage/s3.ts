import fs from 'node:fs';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { assertSafeKey, type GetResult, type SignedUrlOptions, type StorageDriver } from './index.js';
import { contentDisposition } from '../util.js';

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** S3互換（Cloudflare R2 / AWS S3 / Backblaze B2 等）ドライバ。バケットは非公開で運用すること */
export class S3Storage implements StorageDriver {
  readonly name = 's3';
  private client: S3Client;
  private bucket: string;

  constructor(opts: S3Options) {
    if (!opts.bucket) throw new Error('S3_BUCKET is required for STORAGE_DRIVER=s3');
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region || 'auto',
      endpoint: opts.endpoint || undefined,
      forcePathStyle: opts.forcePathStyle,
      credentials: opts.accessKeyId ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } : undefined,
    });
  }

  async putFile(key: string, localPath: string, contentType: string): Promise<void> {
    assertSafeKey(key);
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: fs.createReadStream(localPath), ContentType: contentType },
      partSize: 16 * 1024 * 1024,
      queueSize: 2,
    });
    await upload.done();
  }

  async get(key: string, range?: { start: number; end?: number }): Promise<GetResult> {
    assertSafeKey(key);
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }),
    );
    const total = res.ContentRange ? Number(res.ContentRange.split('/')[1]) : Number(res.ContentLength ?? 0);
    const out: GetResult = { stream: res.Body as Readable, size: total };
    if (range) {
      out.start = range.start;
      out.end = range.start + Number(res.ContentLength ?? 0) - 1;
    }
    return out;
  }

  async head(key: string): Promise<{ size: number } | null> {
    assertSafeKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(res.ContentLength ?? 0) };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async *list(prefix = ''): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix || undefined, ContinuationToken: token }),
      );
      for (const o of res.Contents ?? []) if (o.Key) yield o.Key;
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async signedDownloadUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(opts.disposition, opts.filename),
        ResponseContentType: opts.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: opts.expiresSeconds },
    );
  }
}
