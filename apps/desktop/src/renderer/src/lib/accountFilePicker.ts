import { client } from '../trpc/client';
import { IS_WEB } from './target';
import { useViewState } from '../state/view';
import { BROWSER_FILE_CHUNK_BYTES } from '../../../shared/browser_file_upload';

export type AccountFileKind = 'image' | 'record' | 'video' | 'file';
type FileBinding = { expectedAccountUin: string; expectedAccountConfigId: string };
export function chooseBrowserFile(accept = ''): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    const finish = (file: File | null) => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    document.body.append(input);
    try {
      input.click();
    } catch (error) {
      input.remove();
      reject(error);
    }
  });
}

/** File 按片读取，不将大文件整体装进 JS 内存。桌面保持原生文件框。 */
export async function pickAccountFile(kind: AccountFileKind, binding?: FileBinding) {
  if (!IS_WEB) return client.account.pickSendFile.mutate({ kind });
  const uin = useViewState.getState().openedUin;
  const file = await chooseBrowserFile(
    kind === 'image'
      ? 'image/*'
      : kind === 'video'
        ? 'video/*'
        : kind === 'record'
          ? 'audio/*'
          : '',
  );
  if (!file) return null;
  if (useViewState.getState().openedUin !== uin) throw new Error('账号已切换，请重新选择附件');
  return stageAccountFile(file, binding);
}

export async function stageAccountFile(file: File, expected?: FileBinding) {
  if (!file.size || file.size > 2 * 1024 ** 3) throw new Error('请选择 2 GiB 以内的非空文件');
  const config = expected
    ? { uin: expected.expectedAccountUin, configId: expected.expectedAccountConfigId }
    : await client.account.getAccountConfig.query();
  if (!config?.configId || !config.uin) throw new Error('请先打开账号');
  const binding = {
    expectedAccountUin: String(config.uin),
    expectedAccountConfigId: config.configId,
  };
  const check = () => {
    if (useViewState.getState().openedUin !== binding.expectedAccountUin)
      throw new Error('账号已切换，请重新选择附件');
  };
  check();
  const { id } = await client.account.pickedFileStart.mutate({
    ...binding,
    size: file.size,
    name: file.name,
  });
  try {
    for (let offset = 0; offset < file.size; offset += BROWSER_FILE_CHUNK_BYTES) {
      check();
      const bytes = new Uint8Array(
        await file.slice(offset, offset + BROWSER_FILE_CHUNK_BYTES).arrayBuffer(),
      );
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const next = await client.account.pickedFileChunk.mutate({
        ...binding,
        uploadId: id,
        offset,
        base64: btoa(binary),
      });
      if (next.offset !== offset + bytes.length) throw new Error('附件接收进度不匹配');
    }
    check();
    return await client.account.pickedFileFinish.mutate({ ...binding, uploadId: id });
  } catch (error) {
    await client.account.pickedFileDiscard.mutate({ ...binding, uploadId: id }).catch(() => {});
    throw error;
  }
}
