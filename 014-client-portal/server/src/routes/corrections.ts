import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireClient, requireOperator } from '../auth.js';
import { clientProject, ownedProject, projectDeliverable, projectVersion } from '../access.js';
import type { Ctx, FileRow, ProjectRow } from '../context.js';
import { contentDisposition, notFound, parseJsonArray, todayYmd } from '../util.js';
import { fileDto, type Audience } from '../services/dto.js';
import type { CommentRow } from '../services/review.js';
import { PIN_TYPE_LABEL, buildInstructionText, normalizePinType } from '../../../shared/correctionSheet.js';

/**
 * Client Portal 修正指示 — 修正指示書（番号入り画像＋指示一覧）
 *   運営者: GET /api/app/projects/:id/versions/:vid/instructions
 *   顧客:   GET /api/portal/projects/:id/versions/:vid/instructions
 * クエリ: format=json|txt, changeRequestId=（その修正依頼時点で未解決だったピンのみ）, includeResolved=1
 * ピンは既存のピンコメント（comments.pin_*）。番号はピン作成時に確定した pin_number を使う（削除しても振り直さない）。
 */
const query = z.object({
  format: z.enum(['json', 'txt']).default('json'),
  changeRequestId: z.string().max(40).optional(),
  includeResolved: z.enum(['0', '1']).default('0'),
});

function buildSheet(ctx: Ctx, p: ProjectRow, versionId: string, q: z.infer<typeof query>, audience: Audience) {
  const { db } = ctx;
  const v = projectVersion(db, p.id, versionId);
  const d = projectDeliverable(db, p.id, v.deliverable_id);
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(v.file_id) as FileRow;
  let rows = db
    .prepare('SELECT * FROM comments WHERE version_id = ? AND pin_number IS NOT NULL AND deleted_at IS NULL ORDER BY pin_number')
    .all(v.id) as CommentRow[];
  let changeRequest: { id: string; clientName: string; body: string; createdAt: string } | null = null;
  if (q.changeRequestId) {
    const cr = db.prepare('SELECT * FROM change_requests WHERE id = ? AND version_id = ? AND project_id = ?').get(q.changeRequestId, v.id, p.id) as
      | { id: string; client_name: string; body: string; pin_comment_ids_json: string; created_at: string }
      | undefined;
    if (!cr) throw notFound('修正依頼');
    const ids = new Set(parseJsonArray<string>(cr.pin_comment_ids_json));
    rows = rows.filter((r) => ids.has(r.id));
    changeRequest = { id: cr.id, clientName: cr.client_name, body: cr.body, createdAt: cr.created_at };
  } else if (q.includeResolved !== '1') {
    rows = rows.filter((r) => !r.resolved_at);
  }
  const pins = rows.map((r) => {
    const type = normalizePinType(r.pin_type);
    return {
      commentId: r.id,
      number: r.pin_number!,
      type,
      typeLabel: PIN_TYPE_LABEL[type],
      text: r.body,
      x: r.pin_x!,
      y: r.pin_y!,
      resolved: !!r.resolved_at,
      authorType: r.author_type,
      authorName: r.author_name,
      createdAt: r.created_at,
    };
  });
  const info = {
    projectName: p.name,
    imageName: `${d.title} v${v.version_number}（${file.original_name}）`,
    date: todayYmd(),
    note: changeRequest ? `修正依頼（${changeRequest.clientName}）:\n${changeRequest.body}` : '',
  };
  return {
    projectName: p.name,
    deliverable: { id: d.id, title: d.title },
    version: { id: v.id, versionNumber: v.version_number, status: v.status },
    file: fileDto(file, audience),
    canAnnotate: file.preview_kind === 'image',
    changeRequest,
    pins,
    text: buildInstructionText(info, pins),
    info,
  };
}

function send(reply: FastifyReply, sheet: ReturnType<typeof buildSheet>, format: 'json' | 'txt') {
  if (format === 'json') return sheet;
  const body = '﻿' + buildInstructionText(sheet.info, sheet.pins, '\r\n') + '\r\n';
  reply.header('Content-Type', 'text/plain; charset=utf-8');
  reply.header('Content-Disposition', contentDisposition('attachment', `修正指示_${sheet.deliverable.title}_v${sheet.version.versionNumber}.txt`));
  reply.header('Cache-Control', 'no-store');
  return reply.send(body);
}

export async function correctionRoutes(app: FastifyInstance) {
  const ctx: Ctx = app.ctx;
  const { db } = ctx;

  app.get('/api/app/projects/:id/versions/:vid/instructions', async (req: FastifyRequest, reply) => {
    const op = requireOperator(ctx, req);
    const { id, vid } = req.params as { id: string; vid: string };
    const p = ownedProject(db, op.id, id);
    const q = query.parse(req.query);
    return send(reply, buildSheet(ctx, p, vid, q, 'operator'), q.format);
  });

  app.get('/api/portal/projects/:id/versions/:vid/instructions', async (req: FastifyRequest, reply) => {
    const c = requireClient(ctx, req);
    const { id, vid } = req.params as { id: string; vid: string };
    const p = clientProject(db, c, id);
    const q = query.parse(req.query);
    return send(reply, buildSheet(ctx, p, vid, q, 'client'), q.format);
  });
}
