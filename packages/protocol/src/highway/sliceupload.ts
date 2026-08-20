// 闪传 sliceupload —— HTTP 直传层。
// prepare-upload 拿到 rkey 后,按 1 MiB 分片 POST multimedia.qfile.qq.com/sliceupload。
// 每片带 rkey、起止偏移、本片 SHA1、以及从文件头到本片末尾的累积 Sha1StateV。
// 服务端即使 HTTP 200 也可能在业务体里返回错误,必须解析 status,非 "success" 视为失败。

import { createHash } from 'node:crypto';
import { decode, encode, message } from '../protobuf';
import { FLASH_SLICE_SIZE, readFileRange } from './hash-file';

const SLICEUPLOAD_URL = 'https://multimedia.qfile.qq.com/sliceupload';

const FLASH_EMPTY = message([]);

/** sliceupload body f107.f6 — 累积 SHA1 state list。 */
export const FLASH_SHA1_STATE_V = message([
  { name: 'state', tag: 1, type: 'bytes', repeated: true },
]);

/** sliceupload body f107 — 切片 payload。 */
export const FLASH_SLICE_PAYLOAD = message([
  { name: 'field1', tag: 1, type: FLASH_EMPTY },
  { name: 'rkey', tag: 2, type: 'string' },
  { name: 'start', tag: 3, type: 'uint32', force: true },
  { name: 'end', tag: 4, type: 'uint32', force: true },
  { name: 'sha1', tag: 5, type: 'bytes' },
  { name: 'sha1StateV', tag: 6, type: FLASH_SHA1_STATE_V },
  { name: 'chunk', tag: 7, type: 'bytes' },
]);

/** sliceupload HTTP body。 */
export const FLASH_SLICE_UPLOAD_BODY = message([
  { name: 'field1', tag: 1, type: 'uint32', force: true },
  { name: 'appid', tag: 2, type: 'uint32', force: true },
  { name: 'field3', tag: 3, type: 'uint32', force: true },
  { name: 'payload', tag: 107, type: FLASH_SLICE_PAYLOAD },
]);

/** sliceupload HTTP 响应 — f5=status,"success" 表示该片已落盘。 */
export const FLASH_SLICE_UPLOAD_RESP = message([{ name: 'status', tag: 5, type: 'string' }]);

export interface SlicePart {
  rkey: string;
  start: number;
  end: number;
  sha1: Uint8Array;
  sha1StateV: Uint8Array[];
  chunk: Uint8Array;
}

export interface SliceUploadOptions {
  /** 主文件 14901 / png 缩略图 14903 / jpg 缩略图 14902。 */
  appid?: number;
}

/** 构造一片的 sliceupload 请求字节。 */
export function buildSliceBody(part: SlicePart, opts?: SliceUploadOptions): Uint8Array {
  return encode(FLASH_SLICE_UPLOAD_BODY, {
    field1: 0,
    appid: opts?.appid ?? 14901,
    field3: 2,
    payload: {
      field1: {},
      rkey: part.rkey,
      start: part.start,
      end: part.end,
      sha1: part.sha1,
      sha1StateV: { state: part.sha1StateV.map((s) => new Uint8Array(s)) },
      chunk: part.chunk,
    },
  });
}

/** POST 一片到 sliceupload 并校验响应 status。label 用于错误信息定位来源。 */
export async function postSliceupload(bodyBytes: Uint8Array, label: string): Promise<void> {
  const reqAppid = decode(FLASH_SLICE_UPLOAD_BODY, bodyBytes).appid;
  console.log(
    `[sliceupload] ${label}: POST ${SLICEUPLOAD_URL} body=${bodyBytes.length}B appid=${reqAppid}`,
  );
  const resp = await fetch(SLICEUPLOAD_URL, {
    method: 'POST',
    body: new Uint8Array(bodyBytes),
    headers: {
      Accept: '*/*',
      Connection: 'Keep-Alive',
      'User-Agent': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      'Content-Length': String(bodyBytes.length),
      'X-Retried-Times': '1',
    },
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    console.error(`[sliceupload] ${label}: HTTP ${resp.status} 响应=${errBody.slice(0, 300)}`);
    throw new Error(`${label} failed: HTTP ${resp.status} ${errBody.slice(0, 300)}`);
  }
  const respBuf = new Uint8Array(await resp.arrayBuffer());
  const status = decode(FLASH_SLICE_UPLOAD_RESP, respBuf).status;
  console.log(`[sliceupload] ${label}: HTTP ${resp.status}, status=${JSON.stringify(status)}`);
  if (status !== 'success') {
    console.error(
      `[sliceupload] ${label}: 业务失败, 原始响应=${Buffer.from(respBuf).toString('hex').slice(0, 400)}`,
    );
    throw new Error(
      `${label} failed: ${typeof status === 'string' ? status : 'no status in response'}`,
    );
  }
}

/** 按 1 MiB 分片上传整个文件(rkey 来自 prepare-upload;sha1StateV 来自流式哈希)。 */
export async function sliceuploadFile(
  filePath: string,
  fileSize: number,
  rkey: string,
  sha1StateV: Uint8Array[],
  sliceCount: number,
  fileName: string,
): Promise<void> {
  for (let i = 0; i < sliceCount; i++) {
    const start = i * FLASH_SLICE_SIZE;
    const chunkLen = Math.min(FLASH_SLICE_SIZE, fileSize - start);
    const chunk = await readFileRange(filePath, start, chunkLen);
    const chunkSha1 = new Uint8Array(createHash('sha1').update(Buffer.from(chunk)).digest());
    console.log(
      `[sliceupload] ${fileName} slice ${i}: start=${start} end=${start + chunkLen - 1} len=${chunkLen} sha1=${Buffer.from(chunkSha1).toString('hex')}`,
    );
    const bodyBytes = buildSliceBody({
      rkey,
      start,
      end: start + chunkLen - 1,
      sha1: chunkSha1,
      sha1StateV,
      chunk,
    });
    await postSliceupload(bodyBytes, `${fileName} slice ${i}`);
  }
}
