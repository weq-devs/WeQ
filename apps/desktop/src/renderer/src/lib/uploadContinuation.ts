import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type UploadReceipt = {
  id: string;
  name: string;
  size: number;
  lastModified: number;
  updatedAt: number;
};

export function readUploadReceipt(key: string) {
  try {
    const received = JSON.parse(localStorage.getItem(key) ?? 'null') as UploadReceipt | null;
    if (
      received &&
      /^[a-f0-9-]{36}$/i.test(received.id) &&
      Date.now() - received.updatedAt <= 30 * 60_000
    )
      return received;
    if (received) forgetUpload(key);
  } catch {
    /* 未保留本设备的传输记录。 */
  }
}

export function rememberUpload(
  key: string,
  id: string,
  file: Pick<File, 'name' | 'size' | 'lastModified'>,
) {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return false;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        id,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        updatedAt: Date.now(),
      } satisfies UploadReceipt),
    );
    return true;
  } catch {
    return false;
  }
}

export function forgetUpload(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 暂存仍随服务器到期回收。 */
  }
}

export function sameUploadFile(receipt: UploadReceipt, file: File) {
  return (
    receipt.name === file.name &&
    receipt.size === file.size &&
    receipt.lastModified === file.lastModified
  );
}

export async function uploadPrefixHash(file: File, length: number, current: () => void) {
  const hash = sha256.create();
  for (let offset = 0; offset < length; offset += 1024 * 1024) {
    current();
    const bytes = await file.slice(offset, Math.min(offset + 1024 * 1024, length)).arrayBuffer();
    hash.update(new Uint8Array(bytes));
  }
  current();
  return bytesToHex(hash.digest());
}
