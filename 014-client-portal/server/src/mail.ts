import fs from 'node:fs';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from './config.js';
import type { DB } from './db.js';
import { newId, nowIso } from './util.js';

export interface Mailer {
  readonly enabled: boolean;
  enqueue(db: DB, msg: { to: string; subject: string; text: string; dedupeKey?: string }): void;
  flush(db: DB): Promise<{ sent: number; failed: number }>;
}

const MAX_ATTEMPTS = 5;

/**
 * メール送信は outbox 方式。
 * - dedupe_key で重複送信防止
 * - 失敗時は最大5回まで再試行、以降 failed
 * - 送信成功後は本文を消去（マジックリンク等を残さない）
 * - 添付ファイルは一切送らない（ポータルへ誘導するのみ）
 */
export function createMailer(cfg: AppConfig): Mailer {
  const driver = cfg.mail.driver;
  let transport: Transporter | null = null;
  if (driver === 'smtp') {
    if (!cfg.mail.smtpUrl) throw new Error('SMTP_URL is required for MAIL_DRIVER=smtp');
    transport = nodemailer.createTransport(cfg.mail.smtpUrl);
  }
  return {
    enabled: driver !== 'none',
    enqueue(db, msg) {
      if (driver === 'none') return;
      db.prepare(
        `INSERT OR IGNORE INTO mail_outbox (id, to_address, subject, body_text, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId('mail'), msg.to, msg.subject, msg.text, msg.dedupeKey ?? null, nowIso());
    },
    async flush(db) {
      if (driver === 'none') return { sent: 0, failed: 0 };
      const rows = db
        .prepare(`SELECT * FROM mail_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 50`)
        .all() as { id: string; to_address: string; subject: string; body_text: string; attempts: number }[];
      let sent = 0;
      let failed = 0;
      for (const r of rows) {
        try {
          if (driver === 'dev-file') {
            fs.mkdirSync(cfg.mail.devDir, { recursive: true });
            fs.writeFileSync(
              path.join(cfg.mail.devDir, `${r.id}.eml`),
              `From: ${cfg.mail.from}\nTo: ${r.to_address}\nSubject: ${r.subject}\n\n${r.body_text}\n`,
              { mode: 0o600 },
            );
          } else if (transport) {
            await transport.sendMail({ from: cfg.mail.from, to: r.to_address, subject: r.subject, text: r.body_text });
          }
          db.prepare(`UPDATE mail_outbox SET status='sent', sent_at=?, body_text='(sent)', attempts=attempts+1 WHERE id=?`).run(nowIso(), r.id);
          sent++;
        } catch (e) {
          const attempts = r.attempts + 1;
          db.prepare(`UPDATE mail_outbox SET attempts=?, last_error=?, status=? WHERE id=?`).run(
            attempts,
            String((e as Error).message).slice(0, 300),
            attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            r.id,
          );
          failed++;
        }
      }
      return { sent, failed };
    },
  };
}
