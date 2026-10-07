import { useRef, useState } from 'react';
import { ApiError, uploadFile, type UploadProgress } from '../api';
import { fmtSize, useOnline } from './ui';
import { naturalCompare } from '../../../shared/photoSelect';

interface Job {
  key: string;
  file: File;
  progress: UploadProgress;
  error?: string;
  uploadId?: string;
  done?: boolean;
  retryable?: boolean;
}

/**
 * ファイル選択・ドラッグ&ドロップ・スマホの写真/動画選択に対応したアップローダー。
 * 進捗・失敗・再試行（中断箇所から再開）を表示する。
 */
export function Uploader({
  initUrl,
  extra,
  onUploaded,
  multiple = true,
  label = 'ファイルを追加',
  mediaButton = true,
  disabled,
  maxFiles = 20,
  sortByName = false,
  accept,
  onBatchDone,
}: {
  initUrl: string;
  extra: Record<string, unknown>;
  onUploaded: (result: any) => void;
  multiple?: boolean;
  label?: string;
  mediaButton?: boolean;
  disabled?: boolean;
  /** 1回に選べる最大件数（既定20） */
  maxFiles?: number;
  /** 送信前にファイル名の自然順（IMG_2 → IMG_10）に並べる（写真セレクト用） */
  sortByName?: boolean;
  /** ファイル選択の accept（既定なし） */
  accept?: string;
  /** 選んだファイルをすべて処理し終えたとき */
  onBatchDone?: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);
  const online = useOnline();

  const update = (key: string, patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));

  async function run(job: Job, resumeId?: string) {
    update(job.key, { error: undefined, progress: { ...job.progress, phase: 'uploading' } });
    try {
      const r = await uploadFile(initUrl, job.file, extra, (p) => update(job.key, { progress: p }), { resumeId });
      update(job.key, { done: true });
      onUploaded(r);
      setTimeout(() => setJobs((js) => js.filter((j) => j.key !== job.key)), 2500);
    } catch (e) {
      const err = e as ApiError & { uploadId?: string };
      const retryable = err.status === 0 || err.status >= 500 || err.code === 'chunk_failed' || err.code === 'network';
      update(job.key, { error: err.message, uploadId: err.uploadId, retryable });
    }
  }

  function add(files: FileList | null) {
    if (!files || files.length === 0) return;
    let list = Array.from(files);
    if (sortByName) list.sort((a, b) => naturalCompare(a.name, b.name));
    list = list.slice(0, multiple ? maxFiles : 1);
    const newJobs = list.map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, progress: { loaded: 0, total: file.size, phase: 'uploading' as const } }));
    setJobs((js) => [...js, ...newJobs]);
    // 順番に送る（モバイル回線での同時送信を避ける）
    void (async () => {
      for (const j of newJobs) await run(j);
      onBatchDone?.();
    })();
  }

  return (
    <div>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled && online) add(e.dataTransfer.files);
        }}
      >
        <div className="row" style={{ justifyContent: 'center' }}>
          {mediaButton && (
            <button type="button" className="btn primary" disabled={disabled || !online} onClick={() => mediaRef.current?.click()}>
              📷 写真・動画を選ぶ
            </button>
          )}
          <button type="button" className={`btn ${mediaButton ? '' : 'primary'}`} disabled={disabled || !online} onClick={() => fileRef.current?.click()}>
            📎 {label}
          </button>
        </div>
        <div className="muted small" style={{ marginTop: 8 }}>
          {online ? 'パソコンではここにドラッグ&ドロップもできます' : 'オフラインのためアップロードできません'}
        </div>
        <input ref={fileRef} type="file" className="hidden" multiple={multiple} accept={accept} onChange={(e) => (add(e.target.files), (e.target.value = ''))} data-testid="file-input" />
        <input ref={mediaRef} type="file" className="hidden" accept="image/*,video/*" multiple={multiple} onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
      </div>
      {jobs.map((j) => {
        const pct = j.progress.total ? Math.round((j.progress.loaded / j.progress.total) * 100) : 0;
        return (
          <div className="upl" key={j.key}>
            <div className="row between small">
              <span style={{ fontWeight: 600 }}>{j.file.name}</span>
              <span className="muted">{fmtSize(j.file.size)}</span>
            </div>
            <div className={`progress ${j.done ? 'ok' : ''}`} aria-label="アップロード進捗">
              <div style={{ width: `${pct}%` }} />
            </div>
            <div className="small">
              {j.error ? (
                <span style={{ color: 'var(--danger)' }}>{j.error}</span>
              ) : j.done ? (
                <span style={{ color: 'var(--ok)' }}>完了しました</span>
              ) : j.progress.phase === 'processing' ? (
                '確認中（ファイル形式・安全性をチェックしています）…'
              ) : (
                `送信中 ${pct}%`
              )}
            </div>
            {j.error && (
              <div className="row" style={{ marginTop: 4 }}>
                {j.retryable && (
                  <button className="btn small" onClick={() => run(j, j.uploadId)} disabled={!online}>
                    再試行
                  </button>
                )}
                <button className="btn small ghost" onClick={() => setJobs((js) => js.filter((x) => x.key !== j.key))}>
                  閉じる
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
