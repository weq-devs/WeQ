import { open } from 'node:fs/promises';
import { decorationFrameBytes } from '../shared/decoration_image';
import { fileResponse } from './file_response';

/** CSS 首帧同样经过尺寸门禁，不能只保护显式调用 Image.decode 的预热路径。 */
export async function decorationImageResponse(
  path: string,
  request?: Request,
  revalidate = false,
): Promise<Response> {
  const head = Buffer.alloc(24);
  let size: number;
  try {
    const file = await open(path, 'r');
    try {
      size = (await file.read(head, 0, head.length, 0)).bytesRead;
    } finally {
      await file.close();
    }
  } catch {
    return new Response('decoration image not found', { status: 404 });
  }
  try {
    decorationFrameBytes(head.subarray(0, size));
  } catch {
    return new Response('invalid decoration image', { status: 413 });
  }
  return fileResponse(path, request, { revalidate });
}
