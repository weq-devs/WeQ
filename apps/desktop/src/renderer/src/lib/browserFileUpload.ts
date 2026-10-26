import {
  BROWSER_FILE_CHUNK_BYTES,
  BROWSER_FILE_MAX_BYTES,
} from '../../../shared/browser_file_upload';

type Binding = { expectedAccountUin: string; expectedAccountConfigId: string };
type UploadApi = {
  browserFileStart: { mutate: (input: Binding & { size: number }) => Promise<{ id: string }> };
  browserFileChunk: {
    mutate: (
      input: Binding & { uploadId: string; offset: number; base64: string },
    ) => Promise<{ offset: number }>;
  };
  browserFileDiscard: { mutate: (input: Binding & { uploadId: string }) => Promise<unknown> };
};

/** 只重用分段暂存机制，不重试上传或真实发送；迟到回执也先复核会话。 */
export async function withBrowserFile<T>(
  api: UploadApi,
  binding: Binding,
  bytes: Uint8Array,
  isCurrent: () => boolean,
  send: (uploadId: string) => Promise<T>,
): Promise<T> {
  if (!bytes.length || bytes.length > BROWSER_FILE_MAX_BYTES)
    throw new Error('请选择 100 MB 以内的非空文件');
  const check = () => {
    if (!isCurrent()) throw new Error('账号或会话已切换，未发送文件');
  };
  check();
  const { id } = await api.browserFileStart.mutate({ ...binding, size: bytes.length });
  try {
    for (let offset = 0; offset < bytes.length; offset += BROWSER_FILE_CHUNK_BYTES) {
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
    }
    check();
    return await send(id);
  } finally {
    // 正常发送由服务端清理；切号后的旧句柄由服务端到期回收。
    await api.browserFileDiscard.mutate({ ...binding, uploadId: id }).catch(() => {});
  }
}
