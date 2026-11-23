// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  comparableMessages,
  compareMessageWindow,
  contentVersion,
} from '../src/shared/content_version';
import { chatImageResponse } from '../src/main/chat_image_response';

vi.mock('../src/main/image_processor', () => ({
  imageThumbnail: async (bytes: Uint8Array) => Buffer.from(bytes),
}));

it('命中同一账号和规格的缩图版本时返回空 304，文件换版后重新交付', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-preview-'));
  const path = join(root, 'photo');
  try {
    await writeFile(path, 'first');
    const url = 'http://example.test/_media/pic';
    const first = await chatImageResponse(
      path,
      new Request(url),
      undefined,
      false,
      'account',
      true,
    );
    const etag = first.headers.get('etag')!;
    expect(first.headers.get('cache-control')).toBe('private, max-age=300');
    const request = new Request(url, { headers: { 'if-none-match': etag } });
    const cached = await chatImageResponse(path, request, undefined, false, 'account', true);
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    expect((await chatImageResponse(path, request, undefined, false, 'other', true)).status).toBe(
      200,
    );
    expect((await chatImageResponse(path, request, undefined, true, 'account', true)).status).toBe(
      200,
    );
    await writeFile(path, 'replacement');
    const changed = await chatImageResponse(path, request, undefined, false, 'account', true);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(await changed.text()).toBe('replacement');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('只在完整前缀一致时缩减消息回包；同序号插入、撤回和删除必须更新旧行', () => {
  const row = (msgId: string, msgSeq: string) => ({
    msgId,
    msgSeq,
    senderUid: 'friend',
    senderUin: '123',
    sendTime: '1',
    elements: [{ text: msgId }],
  });
  const older = row('old', '1'),
    latest = row('latest', '2'),
    next = row('next', '3');
  const known = { count: 2, version: contentVersion(comparableMessages([older, latest])) };
  const compare = (rows: Array<typeof older & { recall?: object }>, limit = 500) =>
    compareMessageWindow(rows, known, limit, comparableMessages);
  expect(compare([{ ...older }, { ...latest }])).toEqual({ kind: 'unchanged' });
  expect(compare([older, latest, next])).toEqual({ kind: 'append', rows: [next] });
  expect(compare([older, latest, next], 3).kind).toBe('replace');
  expect(compare([{ ...older, recall: { time: 123 } }, latest, next]).kind).toBe('replace');
  expect(compare([latest, next]).kind).toBe('replace');
  expect(compare([older, row('gray', '1'), latest]).kind).toBe('replace');
});
