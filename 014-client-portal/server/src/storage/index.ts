import type { Readable } from 'node:stream';
import type { AppConfig } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export interface GetResult {
  stream: Readable;
  size: number;
  /** Range指定時の実際の範囲 */
  start?: number;
  end?: number;
}

export interface SignedUrlOptions {
  filename: string;
  disposition: 'inline' | 'attachment';
  contentType: string;
  expiresSeconds: number;
}

export interface StorageDriver {
  readonly name: string;
  /** ローカル一時ファイルをストレージへ保存（完了まで他から見えない） */
  putFile(key: string, localPath: string, contentType: string): Promise<void>;
  get(key: string, range?: { start: number; end?: number }): Promise<GetResult>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): AsyncIterable<string>;
  /** 外部ストレージの期限付きURL。ローカルの場合 null（アプリ経由で配信） */
  signedDownloadUrl(key: string, opts: SignedUrlOptions): Promise<string | null>;
}

const KEY_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

/** ストレージキーはサーバー生成IDのみで構成し、ユーザー入力（ファイル名等）は含めない */
export function assertSafeKey(key: string): void {
  if (!KEY_RE.test(key) || key.length > 200) throw new Error('unsafe storage key');
}

export function objectKey(projectId: string, fileId: string): string {
  const key = `p/${projectId}/${fileId}`;
  assertSafeKey(key);
  return key;
}

export function createStorage(cfg: AppConfig): StorageDriver {
  if (cfg.storage.driver === 's3') return new S3Storage(cfg.storage.s3);
  return new LocalStorage(cfg.storage.localDir);
}
