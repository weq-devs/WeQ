import {
  BROWSER_FILE_CHUNK_BYTES,
  BROWSER_FILE_MAX_BYTES,
} from '../../../shared/browser_file_upload';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { forgetUpload, readUploadReceipt, rememberUpload } from './uploadContinuation';

type Binding = { expectedAccountUin: string; expectedAccountConfigId: string };
type UploadApi = {
  browserFileStart: { mutate: (input: Binding & { size: number }) => Promise<{ id: string }> };
  browserFileResume?: {
    mutate: (
      input: Binding & { uploadId: string },
    ) => Promise<{ id: string; size: number; offset: number; prefixHash: string } | null>;
  };
  browserFileChunk: {
    mutate: (
      input: Binding & { uploadId: string; offset: number; base64: string },
    ) => Promise<{ offset: number }>;
  };
  browserFileDiscard: { mutate: (input: Binding & { uploadId: string }) => Promise<unknown> };
};

/** 可以续传到宿主的分片。交给 QQ 发送后保留原消息的回执处理。 */
export async function withBrowserFile<T>(
  api: UploadApi,
  binding: Binding,
  bytes: Uint8Array,
  isCurrent: () => boolean,
  send: (uploadId: string) => Promise<T>,
  onProgress?: (received: number, total: number) => void,
  resumeTarget?: string,
): Promise<T> {
  if (!bytes.length || bytes.length > BROWSER_FILE_MAX_BYTES)
    throw new Error('请选择 100 MB 以内的非空文件');
  const check = () => {
    if (!isCurrent()) throw new Error('账号或会话已切换，未发送文件');
  };
  check();
  const key =
    api.browserFileResume && resumeTarget
      ? `weq-outgoing-file-transfer-v1:${JSON.stringify([binding.expectedAccountConfigId, resumeTarget])}`
      : undefined;
  const digest = key ? bytesToHex(sha256(bytes)) : undefined;
  const saved = key ? readUploadReceipt(key) : undefined;
  let resumed =
    saved?.name === digest && saved
      ? await api.browserFileResume!.mutate({ ...binding, uploadId: saved.id })
      : null;
  if (
    resumed &&
    (resumed.size !== bytes.length ||
      resumed.prefixHash !== bytesToHex(sha256(bytes.subarray(0, resumed.offset))))
  ) {
    await api.browserFileDiscard.mutate({ ...binding, uploadId: resumed.id });
    resumed = null;
  }
  check();
  const id =
    resumed?.id ?? (await api.browserFileStart.mutate({ ...binding, size: bytes.length })).id;
  let submitted = false;
  const remember = () =>
    key && digest
      ? rememberUpload(key, id, { name: digest, size: bytes.length, lastModified: 0 })
      : false;
  const canResume = remember();
  try {
    onProgress?.(resumed?.offset ?? 0, bytes.length);
    for (
      let offset = resumed?.offset ?? 0;
      offset < bytes.length;
      offset += BROWSER_FILE_CHUNK_BYTES
    ) {
      check();
      const chunk = bytes.subarray(offset, offset + BROWSER_FILE_CHUNK_BYTES);
      let binary = '';
      for (let i = 0; i < chunk.length; i += 8192)
        binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      const next = await api.browserFileChunk.mutate({
        ...binding,
        uploadId: id,
        offset,
        base64: btoa(binary),
      });
      if (next.offset !== offset + chunk.length) throw new Error('附件接收进度不匹配，请重新选择');
      check();
      onProgress?.(next.offset, bytes.length);
    }
    check();
    submitted = true;
    if (key) forgetUpload(key);
    return await send(id);
  } finally {
    if (submitted || !canResume)
      await api.browserFileDiscard.mutate({ ...binding, uploadId: id }).catch(() => {});
    else remember();
  }
}
