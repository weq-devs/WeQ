/**
 * 合并转发节点里的**文件**编码单测。
 *
 * 文件不进 richText.elems：群聊编成 transElem(24)，私聊编成 body.msgContent 的
 * FileExtra。这两条都是「收端按常规 msg-push 解码」的形状，所以最有力的断言是
 * 把编码出来的 PushMsgBody 再喂回 decodeMessage，看能不能解出文件元素。
 *
 * 文件本体的上传（OIDB + highway）在 sendGroupFile / sendPrivateFile 里，这里整块
 * mock 掉 —— 只验证「拿到上传结果之后怎么编进长消息」。
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/file/file-send', () => ({
  sendGroupFile: vi.fn(async () => ({
    fileId: 'group-file-id',
    fileName: 'report.pdf',
    fileSize: 12345,
    md5Hex: '00112233445566778899aabbccddeeff',
    sha1Hex: 'aabbccdd',
    fastUpload: true,
    published: false,
  })),
  sendPrivateFile: vi.fn(async () => ({
    fileId: 'private-uuid',
    fileHash: 'file-hash-xyz',
    fileName: 'report.pdf',
    fileSize: 12345,
    md5Hex: '00112233445566778899aabbccddeeff',
    fastUpload: true,
    finalized: false,
    sent: false,
  })),
}));

import {
  buildForwardNodeBody,
  decodeMessage,
  encode,
  PUSH_MSG_BODY,
  type ForwardEncodeContext,
} from '../src/index';

function ctx(scene: 'group' | 'c2c', extra: { groupId?: number; userUid?: string } = {}) {
  const base: ForwardEncodeContext = {
    nt: {} as never,
    pid: 1,
    selfUin: 10001,
    selfUid: 'u_self',
    scene,
  };
  return {
    ...base,
    ...(extra.groupId !== undefined ? { groupId: extra.groupId } : {}),
    ...(extra.userUid ? { userUid: extra.userUid } : {}),
  };
}

/** 把节点编成 PushMsgBody 字节，再用常规解码器读回来。 */
function decodeNode(body: Record<string, unknown>) {
  return decodeMessage(encode(PUSH_MSG_BODY, body));
}

describe('合并转发节点里的文件', () => {
  it('群聊：编成 transElem(24)，收端能解出文件元素', async () => {
    const body = await buildForwardNodeBody(
      { userUin: 10002, nickname: '甲', elements: [{ kind: 'file', source: '/tmp/report.pdf' }] },
      ctx('group', { groupId: 555 }),
    );
    const elems = (body.body as { richText: { elems: Record<string, unknown>[] } }).richText.elems;
    expect(elems).toHaveLength(1);
    const trans = elems[0]?.transElem as { elemType?: number; elemValue?: Uint8Array } | undefined;
    expect(trans?.elemType).toBe(24);
    expect(trans?.elemValue?.[0]).toBe(0x01);
    const declared = ((trans!.elemValue![1]! << 8) | trans!.elemValue![2]!) >>> 0;
    expect(declared).toBe(trans!.elemValue!.length - 3);

    const decoded = decodeNode(body);
    const file = decoded.elements.find((e) => e.kind === 'file') as
      | { kind: string; fileName?: string; fileSize?: number; fileToken?: string; busId?: number }
      | undefined;
    expect(file).toBeDefined();
    expect(file?.fileName).toBe('report.pdf');
    expect(file?.fileSize).toBe(12345);
    expect(file?.fileToken).toBe('group-file-id');
    expect(file?.busId).toBe(102);
  });

  it('私聊：编成 body.msgContent 的 FileExtra，收端能解出文件元素', async () => {
    const body = await buildForwardNodeBody(
      { userUin: 10002, nickname: '甲', elements: [{ kind: 'file', source: '/tmp/report.pdf' }] },
      ctx('c2c', { userUid: 'u_peer' }),
    );
    expect(body.body as unknown).toBeTruthy();
    expect((body.body as { msgContent?: Uint8Array }).msgContent).toBeInstanceOf(Uint8Array);

    const decoded = decodeNode(body);
    const file = decoded.elements.find((e) => e.kind === 'file') as
      | { kind: string; fileName?: string; fileSize?: number; fileToken?: string }
      | undefined;
    expect(file).toBeDefined();
    expect(file?.fileName).toBe('report.pdf');
    expect(file?.fileSize).toBe(12345);
    expect(file?.fileToken).toBe('private-uuid');
  });

  it('私聊：一个节点里放两个文件在联网之前就报错', async () => {
    await expect(
      buildForwardNodeBody(
        {
          elements: [
            { kind: 'file', source: '/tmp/a.bin' },
            { kind: 'file', source: '/tmp/b.bin' },
          ],
        },
        ctx('c2c', { userUid: 'u_peer' }),
      ),
    ).rejects.toThrow(/最多只能有一个文件/);
  });

  it('file 元素没有本机路径 → 报错（不是静默丢）', async () => {
    await expect(
      buildForwardNodeBody(
        { elements: [{ kind: 'file', source: '' }] },
        ctx('group', { groupId: 555 }),
      ),
    ).rejects.toThrow(/本机文件路径/);
  });

  it('文件与普通文本可以共存（文本在 elems、文件在各自槽位）', async () => {
    const body = await buildForwardNodeBody(
      {
        elements: [
          { kind: 'text', textContent: '这是文件' },
          { kind: 'file', source: '/tmp/report.pdf' },
        ],
      },
      ctx('group', { groupId: 555 }),
    );
    const elems = (body.body as { richText: { elems: Record<string, unknown>[] } }).richText.elems;
    expect(elems.some((e) => e.transElem)).toBe(true);
    expect(elems.some((e) => e.text)).toBe(true);
  });
});
