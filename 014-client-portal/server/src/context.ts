import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from './config.js';
import type { DB } from './db.js';
import type { StorageDriver } from './storage/index.js';
import type { Mailer } from './mail.js';

export interface Ctx {
  cfg: AppConfig;
  db: DB;
  storage: StorageDriver;
  mailer: Mailer;
  log: FastifyBaseLogger | Console;
}

export type ActorType = 'operator' | 'client' | 'system' | 'anonymous';

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}

export interface OperatorRow {
  id: string;
  email: string;
  name: string;
  business_name: string;
  status: string;
}

export interface ClientRow {
  id: string;
  owner_id: string;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  internal_memo: string;
  status: string;
  is_sample: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  client_id: string;
  name: string;
  description: string;
  start_date: string | null;
  due_date: string | null;
  status: string;
  client_status_label: string;
  client_guidance: string;
  internal_memo: string;
  portal_status: string;
  categories_json: string;
  checklist_json: string;
  template_id: string | null;
  is_sample: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: string;
  project_id: string;
  owner_id: string;
  uploader_type: 'operator' | 'client';
  uploader_id: string;
  original_name: string;
  storage_key: string;
  mime: string;
  size: number;
  sha256: string;
  purpose: 'request_attachment' | 'deliverable_version' | 'delivery_extra' | 'internal' | 'selection_photo';
  request_id: string | null;
  version_group_id: string | null;
  version_number: number | null;
  preview_kind: 'image' | 'pdf' | 'video' | 'none';
  width: number | null;
  height: number | null;
  status: 'active' | 'withdrawn';
  created_at: string;
}

export interface VersionRow {
  id: string;
  deliverable_id: string;
  project_id: string;
  version_number: number;
  file_id: string;
  note: string;
  checklist_json: string;
  review_due_date: string | null;
  status: 'in_review' | 'changes_requested' | 'approved' | 'superseded';
  submitted_by: string;
  submitted_at: string;
}

export interface DeliverableRow {
  id: string;
  project_id: string;
  title: string;
  category: string;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRow {
  id: string;
  project_id: string;
  deliverable_id: string;
  version_id: string;
  version_number: number;
  client_id: string;
  client_name: string;
  file_id: string;
  file_sha256: string;
  comment: string;
  idempotency_key: string;
  user_agent: string;
  ip_hash: string;
  approved_at: string;
  revoked_at: string | null;
  revoked_by_type: string | null;
  revoked_by_id: string | null;
  revoke_reason: string | null;
}

export interface RequestRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  kind: 'file' | 'text' | 'url' | 'choice' | 'check';
  required: number;
  due_date: string | null;
  choices_json: string;
  status: 'pending' | 'submitted' | 'returned' | 'accepted';
  answer_text: string | null;
  answer_url: string | null;
  answer_choice: string | null;
  answer_checked: number | null;
  submitted_at: string | null;
  submitted_by: string | null;
  reviewed_at: string | null;
  return_reason: string;
  internal_memo: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface DeliveryRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  notice: string;
  expires_at: string | null;
  status: 'draft' | 'published' | 'withdrawn';
  published_at: string | null;
  created_at: string;
  updated_at: string;
}
