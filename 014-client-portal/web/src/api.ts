export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function parse(res: Response) {
  const ct = res.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await res.json() : {};
  if (!res.ok) {
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `エラーが発生しました（${res.status}）`, body);
  }
  return body;
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  if (method !== 'GET' && typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ApiError(0, 'offline', 'オフラインのため送信できません。通信状態を確認してください');
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-cp-csrf': '1' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', '通信に失敗しました。電波の良い場所で再度お試しください');
  }
  return parse(res);
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body?: unknown) => api<T>('POST', url, body ?? {});
export const patch = <T = any>(url: string, body?: unknown) => api<T>('PATCH', url, body ?? {});
export const del = <T = any>(url: string, body?: unknown) => api<T>('DELETE', url, body ?? {});

export interface UploadProgress {
  loaded: number;
  total: number;
  phase: 'uploading' | 'processing' | 'done' | 'error';
}

function putChunk(url: string, blob: Blob, onProgress: (loaded: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-cp-csrf', '1');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let msg = `送信に失敗しました（${xhr.status}）`;
        let code = 'chunk_failed';
        try {
          const b = JSON.parse(xhr.responseText);
          msg = b.message ?? msg;
          code = b.error ?? code;
        } catch {
          /* ignore */
        }
        reject(new ApiError(xhr.status, code, msg));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', '通信が切れました'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', '中止しました'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 分割アップロード。チャンク単位で自動再試行（最大4回, 指数バックオフ）。
 * 失敗時は uploadId を保持したエラーを返し、resumeUpload で続きから再開できる。
 */
export async function uploadFile(
  initUrl: string,
  file: File,
  extra: Record<string, unknown>,
  onProgress: (p: UploadProgress) => void,
  opts: { signal?: AbortSignal; resumeId?: string } = {},
): Promise<any> {
  let uploadId = opts.resumeId;
  let chunkSize: number;
  let chunkCount: number;
  let received = new Set<number>();
  if (uploadId) {
    const st = await get(`/api/uploads/${uploadId}`);
    chunkSize = st.chunkSize;
    chunkCount = st.chunkCount;
    received = new Set(st.received);
    if (st.status === 'completed') return post(`/api/uploads/${uploadId}/complete`);
  } else {
    const init = await post(initUrl, { name: file.name, size: file.size, mime: file.type, ...extra });
    uploadId = init.uploadId;
    chunkSize = init.chunkSize;
    chunkCount = init.chunkCount;
  }
  const doneBytes = () => [...received].reduce((s, i) => s + Math.min(chunkSize, file.size - i * chunkSize), 0);
  try {
    for (let i = 0; i < chunkCount; i++) {
      if (received.has(i)) continue;
      const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
      let attempt = 0;
      for (;;) {
        try {
          const base = doneBytes();
          await putChunk(`/api/uploads/${uploadId}/chunks/${i}`, blob, (l) => onProgress({ loaded: base + l, total: file.size, phase: 'uploading' }), opts.signal);
          received.add(i);
          break;
        } catch (e) {
          const err = e as ApiError;
          if (err.code === 'aborted' || (err.status >= 400 && err.status < 500) || attempt >= 4) throw err;
          attempt++;
          await sleep(1000 * 2 ** attempt);
        }
      }
    }
    onProgress({ loaded: file.size, total: file.size, phase: 'processing' });
    let attempt = 0;
    for (;;) {
      try {
        const r = await post(`/api/uploads/${uploadId}/complete`);
        onProgress({ loaded: file.size, total: file.size, phase: 'done' });
        return r;
      } catch (e) {
        const err = e as ApiError;
        if ((err.status >= 400 && err.status < 500 && err.code !== 'in_progress') || attempt >= 3) throw err;
        attempt++;
        await sleep(1500 * attempt);
      }
    }
  } catch (e) {
    onProgress({ loaded: doneBytes(), total: file.size, phase: 'error' });
    (e as ApiError & { uploadId?: string }).uploadId = uploadId;
    throw e;
  }
}

export function newIdempotencyKey(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
