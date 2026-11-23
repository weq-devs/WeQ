import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BROWSER_FILE_CHUNK_BYTES,
  PICKED_FILE_UPLOAD_PREFIX,
} from '../../shared/browser_file_upload';
import { pickedBrowserFiles } from '../browser_files';
import { assertResourceSource, requireResourceSource } from '../ipc/routers/resource_source';
import { runtimeMaintenance } from '../runtime_maintenance';

function send(res: ServerResponse, status: number, data: object, close = false) {
  if (res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(close ? { Connection: 'close' } : {}),
  });
  res.end(JSON.stringify(data));
}

export async function uploadPickedFileChunk(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  isAuthed: (req: IncomingMessage) => boolean,
) {
  if (req.method !== 'PUT') return send(res, 405, { error: '只接受 PUT。' }, true);
  if (req.headers['content-type'] !== 'application/octet-stream')
    return send(res, 415, { error: '需要二进制附件分段。' }, true);
  if (req.headers.origin) {
    const origin = URL.parse(req.headers.origin);
    if (
      !origin ||
      !['http:', 'https:'].includes(origin.protocol) ||
      !req.headers.host ||
      origin.origin !== URL.parse(`${origin.protocol}//${req.headers.host}`)?.origin
    )
      return send(res, 403, { error: '来源不匹配。' }, true);
  }
  const uploadId = path.slice(PICKED_FILE_UPLOAD_PREFIX.length);
  const offsetText = req.headers['x-weq-upload-offset'];
  const length =
    req.headers['content-length'] === undefined ? undefined : Number(req.headers['content-length']);
  if (
    length !== undefined &&
    (!Number.isSafeInteger(length) || length < 1 || length > BROWSER_FILE_CHUNK_BYTES)
  )
    return send(res, 413, { error: '附件分段超过 1 MiB 或为空。' }, true);
  const offset = Number(offsetText);
  if (
    !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(uploadId) ||
    typeof offsetText !== 'string' ||
    !/^\d+$/.test(offsetText) ||
    !Number.isSafeInteger(offset)
  )
    return send(res, 400, { error: '附件分段参数无效。' }, true);

  const uin = req.headers['x-weq-upload-account'];
  const config = req.headers['x-weq-upload-source'];
  if (typeof uin !== 'string' || typeof config !== 'string' || !uin || !config)
    return send(res, 400, { error: '缺少附件账号来源。' }, true);
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  let reading = true;
  try {
    const binding = {
      expectedAccountUin: decodeURIComponent(uin),
      expectedAccountConfigId: decodeURIComponent(config),
    };
    const owner = requireResourceSource(binding);
    pickedBrowserFiles.checkAppend(owner, uploadId, offset);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      controller.signal.throwIfAborted();
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      if (bytes > BROWSER_FILE_CHUNK_BYTES)
        return send(res, 413, { error: '附件分段超过 1 MiB。' }, true);
      chunks.push(buffer);
    }
    reading = false;
    controller.signal.throwIfAborted();
    if (!bytes || (length !== undefined && length !== bytes))
      return send(res, 400, { error: '附件分段长度不匹配。' });
    if (!isAuthed(req)) return send(res, 401, { error: '连接授权已失效。' });
    assertResourceSource(owner, binding);
    const data = await runtimeMaintenance.operation(
      () =>
        pickedBrowserFiles.append(
          owner,
          uploadId,
          offset,
          Buffer.concat(chunks, bytes),
          controller.signal,
          () => {
            assertResourceSource(owner, binding);
            if (!isAuthed(req)) throw new Error('连接授权已失效。');
          },
        ),
      'account.pickedFileChunk',
    );
    assertResourceSource(owner, binding);
    if (!isAuthed(req)) return send(res, 401, { error: '连接授权已失效。' });
    send(res, 200, data);
  } catch (error) {
    if (!controller.signal.aborted)
      send(
        res,
        409,
        { error: error instanceof Error ? error.message : '附件分段保存失败。' },
        reading,
      );
  } finally {
    res.off('close', abort);
  }
}
