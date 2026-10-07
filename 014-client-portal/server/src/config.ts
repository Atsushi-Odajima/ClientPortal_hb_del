import path from 'node:path';

export const APP_VERSION = '1.0.0';
export const SCHEMA_VERSION = 2;

export type StorageDriverName = 'local' | 's3';
export type MailDriverName = 'none' | 'dev-file' | 'smtp';

export interface Limits {
  /** 1ファイルの最大サイズ（bytes） */
  maxUploadBytes: number;
  /** 分割アップロードのチャンクサイズ（bytes） */
  chunkBytes: number;
  /** 運営者1人あたりの有効案件数上限（0 = 無制限） */
  maxActiveProjectsPerOperator: number;
  /** 1案件あたりの総ファイル容量上限（bytes, 0 = 無制限） */
  maxProjectStorageBytes: number;
  /** ZIP一括ダウンロードの最大合計サイズ（bytes） */
  maxZipBytes: number;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  /** 公開URL（招待リンク生成・Origin検証に使用） 例 https://portal.example.com */
  publicUrl: string;
  dataDir: string;
  dbPath: string;
  sessionSecret: string;
  setupToken: string;
  allowSignup: boolean;
  secureCookies: boolean;
  storage: {
    driver: StorageDriverName;
    localDir: string;
    s3: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle: boolean;
    };
    signedUrlSeconds: number;
  };
  mail: {
    driver: MailDriverName;
    from: string;
    smtpUrl: string;
    devDir: string;
  };
  invite: {
    defaultDays: number;
    maxDays: number;
    magicLinkMinutes: number;
  };
  sessions: {
    operatorDays: number;
    clientDays: number;
  };
  limits: Limits;
  passwordScryptN: number;
  webDist: string;
  trustProxy: boolean;
  logLevel: string;
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number in env: ${v}`);
  return n;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const MB = 1024 * 1024;

export function loadConfig(overrides: Partial<AppConfig> = {}, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development') as AppConfig['env'];
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${num(env.PORT, 8787)}`).replace(/\/$/, '');
  const sessionSecret = env.SESSION_SECRET ?? '';
  if (nodeEnv === 'production' && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set (32+ chars) in production');
  }
  const cfg: AppConfig = {
    env: nodeEnv,
    port: num(env.PORT, 8787),
    host: env.HOST ?? '0.0.0.0',
    publicUrl,
    dataDir,
    dbPath: path.join(dataDir, 'portal.sqlite'),
    sessionSecret: sessionSecret || 'dev-only-insecure-secret-change-me-0000000000',
    setupToken: env.SETUP_TOKEN ?? '',
    allowSignup: bool(env.ALLOW_SIGNUP, nodeEnv !== 'production'),
    secureCookies: bool(env.SECURE_COOKIES, publicUrl.startsWith('https://')),
    storage: {
      driver: (env.STORAGE_DRIVER as StorageDriverName) ?? 'local',
      localDir: path.join(dataDir, 'objects'),
      s3: {
        endpoint: env.S3_ENDPOINT ?? '',
        region: env.S3_REGION ?? 'auto',
        bucket: env.S3_BUCKET ?? '',
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
        forcePathStyle: bool(env.S3_FORCE_PATH_STYLE, false),
      },
      signedUrlSeconds: num(env.SIGNED_URL_SECONDS, 300),
    },
    mail: {
      driver: (env.MAIL_DRIVER as MailDriverName) ?? 'none',
      from: env.MAIL_FROM ?? 'Client Portal <no-reply@example.invalid>',
      smtpUrl: env.SMTP_URL ?? '',
      devDir: path.join(dataDir, 'mail-dev'),
    },
    invite: {
      defaultDays: num(env.INVITE_DEFAULT_DAYS, 14),
      maxDays: num(env.INVITE_MAX_DAYS, 90),
      magicLinkMinutes: num(env.MAGIC_LINK_MINUTES, 15),
    },
    sessions: {
      operatorDays: num(env.OPERATOR_SESSION_DAYS, 14),
      clientDays: num(env.CLIENT_SESSION_DAYS, 30),
    },
    limits: {
      maxUploadBytes: num(env.MAX_UPLOAD_MB, 500) * MB,
      chunkBytes: num(env.CHUNK_MB, 8) * MB,
      maxActiveProjectsPerOperator: num(env.MAX_ACTIVE_PROJECTS, 0),
      maxProjectStorageBytes: num(env.MAX_PROJECT_STORAGE_MB, 0) * MB,
      maxZipBytes: num(env.MAX_ZIP_MB, 4096) * MB,
    },
    passwordScryptN: num(env.PASSWORD_SCRYPT_N, 65536),
    webDist: path.resolve(env.WEB_DIST ?? './dist/web'),
    trustProxy: bool(env.TRUST_PROXY, nodeEnv === 'production'),
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
  };
  const merged = { ...cfg, ...overrides };
  if (overrides.dataDir && !overrides.dbPath) merged.dbPath = path.join(overrides.dataDir, 'portal.sqlite');
  if (overrides.dataDir && !overrides.storage) merged.storage = { ...cfg.storage, localDir: path.join(overrides.dataDir, 'objects') };
  if (overrides.dataDir && !overrides.mail) merged.mail = { ...cfg.mail, devDir: path.join(overrides.dataDir, 'mail-dev') };
  return merged;
}
