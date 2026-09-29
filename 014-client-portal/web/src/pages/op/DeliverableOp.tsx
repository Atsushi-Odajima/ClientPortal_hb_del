import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, post } from '../../api';
import { AsyncButton, Modal, Page, useApi, useTitle, useToast } from '../../components/ui';
import { Uploader } from '../../components/Uploader';
import { ReviewPanel, type CommentDto, type DeliverableDto } from '../../components/Review';

export function DeliverableOp() {
  const { pid, did } = useParams();
  const st = useApi<{ projectName: string; deliverable: DeliverableDto; comments: Record<string, CommentDto[]>; checklistTemplate: string[] }>(`/api/app/projects/${pid}/deliverables/${did}`, [pid, did]);
  const [sel, setSel] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const toast = useToast();
  useTitle(st.data?.deliverable.title ?? '制作物');
  return (
    <Page state={st}>
      {(d) => {
        const hasVersions = d.deliverable.versions.length > 0;
        const selected = sel && d.deliverable.versions.some((v) => v.id === sel) ? sel : d.deliverable.versions[0]?.id;
        return (
          <div className="stack">
            <div className="muted small">
              <Link to={`/app/projects/${pid}?tab=deliverables`}>{d.projectName}</Link> ／ 制作物
            </div>
            {!hasVersions && <h1>{d.deliverable.title}</h1>}
            <SubmitVersion pid={pid!} deliverable={d.deliverable} checklistTemplate={d.checklistTemplate} onDone={() => (setSel(null), st.reload())} />
            {hasVersions && (
              <ReviewPanel
                base={`/api/app/projects/${pid}`}
                deliverable={d.deliverable}
                comments={d.comments}
                selectedId={selected!}
                onSelect={setSel}
                onChanged={st.reload}
                actions={(v) =>
                  v.approval ? (
                    <div className="card">
                      <div className="alert ok" style={{ marginBottom: 8 }}>
                        ✓ v{v.versionNumber} は {v.approval.clientName} により承認済みです。
                      </div>
                      <button className="btn small ghost" onClick={() => (setRevokeId(v.approval!.id), setReason(''))}>
                        承認を取り消す（顧客から依頼があった場合など）
                      </button>
                    </div>
                  ) : null
                }
              />
            )}
            {revokeId && (
              <Modal title="承認を取り消す" onClose={() => setRevokeId(null)}>
                <p className="small">取消は履歴に残り、顧客にも通知されます。</p>
                <label className="field">
                  <span>理由</span>
                  <textarea value={reason} onChange={(e) => setReason(e.target.value)} />
                </label>
                <AsyncButton
                  className="btn danger block"
                  onClick={async () => {
                    try {
                      await post(`/api/app/projects/${pid}/approvals/${revokeId}/revoke`, { reason });
                      setRevokeId(null);
                      st.reload();
                    } catch (e) {
                      toast((e as ApiError).message);
                    }
                  }}
                >
                  取り消す
                </AsyncButton>
              </Modal>
            )}
          </div>
        );
      }}
    </Page>
  );
}

function SubmitVersion({ pid, deliverable, checklistTemplate, onDone }: { pid: string; deliverable: DeliverableDto; checklistTemplate: string[]; onDone: () => void }) {
  const next = deliverable.latestVersionNumber + 1;
  const [open, setOpen] = useState(deliverable.versions.length === 0);
  const [note, setNote] = useState('');
  const [due, setDue] = useState('');
  const [checklist, setChecklist] = useState(checklistTemplate.join('\n'));
  const toast = useToast();
  useEffect(() => setOpen(deliverable.versions.length === 0), [deliverable.versions.length]);
  const latest = deliverable.versions[0];
  return (
    <div className="card">
      <div className="row between">
        <h3 style={{ margin: 0 }}>{deliverable.versions.length === 0 ? `v1 を提出` : `新しい版（v${next}）を提出`}</h3>
        {deliverable.versions.length > 0 && (
          <button className="btn small" onClick={() => setOpen(!open)}>
            {open ? '閉じる' : '開く'}
          </button>
        )}
      </div>
      {latest && latest.status === 'changes_requested' && !open && <div className="alert warn small" style={{ marginTop: 8 }}>修正依頼があります。修正後、新しい版を提出してください。</div>}
      {open && (
        <div style={{ marginTop: 10 }}>
          {latest?.approval && <div className="alert warn small">v{latest.versionNumber} は承認済みです。新しい版を提出すると承認は引き継がれず、顧客の再承認が必要になります。</div>}
          <label className="field">
            <span>説明（顧客に表示）</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder={next > 1 ? '例: ご指摘の2点を修正しました' : '例: 初稿です'} />
          </label>
          <div className="grid cols-2">
            <label className="field">
              <span>確認期限（任意）</span>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <label className="field">
              <span>確認してほしい点（1行1項目）</span>
              <textarea value={checklist} onChange={(e) => setChecklist(e.target.value)} style={{ minHeight: 60 }} />
            </label>
          </div>
          <Uploader
            initUrl={`/api/app/projects/${pid}/uploads`}
            extra={{
              target: {
                purpose: 'deliverable_version',
                deliverableId: deliverable.id,
                note,
                reviewDueDate: due || null,
                checklist: checklist.split('\n').map((x) => x.trim()).filter(Boolean),
              },
            }}
            multiple={false}
            label="ファイルを選んで提出"
            onUploaded={(r) => {
              toast(`v${r.file.versionNumber ?? next} を提出しました。顧客に通知しました`);
              setNote('');
              setOpen(false);
              onDone();
            }}
          />
          <div className="muted small" style={{ marginTop: 6 }}>
            ファイルの保存が完了した時点で「確認待ち」として顧客に公開されます。提出後の差し替えはできません（新しい版として提出してください）。
          </div>
        </div>
      )}
    </div>
  );
}
