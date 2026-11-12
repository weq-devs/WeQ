import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { expandForwards } from '../src/account/export/forward_expand';
import {
  annotateExportPaths,
  collectFaceIds,
  elementsToText,
} from '../src/account/export/element_text';
import { mediaDirsFromNtDataDir, scanConvMedia } from '../src/account/export/media_scan';
import type { MsgService, RenderGroupMsg } from '../src/account/msg';
import type { ExportedMessage } from '../src/account/export/types';
import type { FetchedForwardRecord } from '../src/account/forward';
import type { RenderElement } from '../src/account/msg_view';
import { downloadMissingVideos } from '../src/account/export/media_export';
import { exportConversationToTxt } from '../src/account/export/txt_exporter';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const card = (resId: string): RenderElement => ({
  type: 'multiMsg',
  data: { resId, sessionId: '', xmlContent: '' },
});
const message = (): ExportedMessage => ({
  msgId: '1',
  msgSeq: '1',
  sendTime: 1,
  senderUid: 'u_fixture',
  senderUin: '123',
  elements: [card('outer')],
});

it('聊天记录专属导出锁定命中的卡片，不导出同消息的文字或其他卡片', async () => {
  const fetch = vi.fn(
    async (resId: string): Promise<FetchedForwardRecord[]> => [
      {
        msgId: '9',
        sendNick: '内部作者',
        senderUin: '456',
        sendTime: '42',
        elements: [{ type: 'text', data: { textContent: `正文 ${resId}` } }],
      },
    ],
  );
  const msgs = {
    exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 2, resId: 'selected' } },
    listForward: async () => [{ elements: [{ elementType: 1, textContent: '不能归属的缓存' }] }],
    exportFetchForward: fetch,
  } as unknown as MsgService;
  const exported = message();
  exported.elements = [
    { type: 'text', data: { textContent: '外层文字' } },
    card('other'),
    card('selected'),
  ];
  await expandForwards(msgs, 'group', exported);
  expect(exported.elements).toHaveLength(1);
  expect(elementsToText(exported.elements)).toContain('正文 selected');
  expect(elementsToText(exported.elements)).not.toContain('外层文字');
  expect(elementsToText(exported.elements)).not.toContain('不能归属的缓存');
  const selected = exported.elements[0];
  if (selected?.type !== 'multiMsg') throw new Error('fixture');
  expect(selected.data.forwardMessages?.[0]).toMatchObject({
    senderName: '内部作者',
    senderUin: '456',
    sendTime: 42,
  });
  await expandForwards(msgs, 'group', exported);
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['root', 'nested', 'cycle'])(
  '专属导出 %s 内容缺失时失败，不输出占位卡片冒充完整记录',
  async (failure) => {
    const msgs = {
      exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 0, resId: 'outer' } },
      listForward: async () => [],
      exportFetchForward: async (resId: string): Promise<FetchedForwardRecord[]> => {
        if (failure === 'root' || resId === 'inner') throw new Error('offline');
        return [{ msgId: '2', elements: [card(failure === 'cycle' ? 'outer' : 'inner')] }];
      },
    } as unknown as MsgService;
    await expect(expandForwards(msgs, 'group', message())).rejects.toThrow('重试');
  },
);

it('专属导出支持 Ark 聊天记录，本地嵌套缓存完整时无需联网', async () => {
  const exported = message();
  exported.elements = [
    {
      type: 'ark',
      data: {
        arkData: JSON.stringify({
          app: 'com.tencent.multimsg',
          meta: { detail: { resid: 'outer' } },
        }),
      },
    } as RenderElement,
  ];
  const msgs = {
    exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 0, resId: 'outer' } },
    listForward: async () => [
      {
        sendNick: '本地作者',
        sendTime: 42,
        elements: [{ elementType: 1, textContent: '缓存正文' }],
      },
    ],
    exportFetchForward: vi.fn(),
  } as unknown as MsgService;
  await expandForwards(msgs, 'c2c', exported);
  expect(elementsToText(exported.elements)).toContain('缓存正文');
  expect(msgs.exportFetchForward).not.toHaveBeenCalled();
});

it('实际 TXT 文件包含卡片内部作者、时间和嵌套正文，不包含外层其他内容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-record-txt-'));
  roots.push(root);
  const row = {
    msgId: 1n,
    msgSeq: 1n,
    senderUid: 'u_carrier',
    senderUin: 123n,
    sendTime: 1n,
    elements: [{ type: 'text', data: { textContent: '不应导出的外层文字' } }, card('outer')],
  };
  const msgs = {
    exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 1, resId: 'outer' } },
    getC2cAfter: async () => [row],
    getC2cSeqlessAfterRowId: async () => [],
    listForward: async () => [],
    exportFetchForward: async (resId: string): Promise<FetchedForwardRecord[]> => [
      {
        msgId: resId === 'outer' ? '2' : '3',
        sendNick: '内部作者',
        senderUin: '456',
        sendTime: '1700000000',
        elements:
          resId === 'outer'
            ? [card('inner')]
            : [{ type: 'text', data: { textContent: '深层完整正文' } }],
      },
    ],
  } as unknown as MsgService;
  const outputPath = join(root, 'record.txt');
  await exportConversationToTxt(msgs, { kind: 'c2c', conv: 'peer', outputPath });
  const output = readFileSync(outputPath, 'utf8');
  expect(output).toContain('内部作者');
  expect(output).toContain('深层完整正文');
  expect(output).toContain('2023');
  expect(output).not.toContain('不应导出的外层文字');
});

it('40900 本地黄金样本展开嵌套正文，不依赖在线接口', async () => {
  const fetch = vi.fn();
  const msgs = {
    listForward: async () => [
      {
        msgId: 88n,
        senderUin: 456,
        sendNick: '本地转发者',
        sendTime: 2,
        elements: [{ elementType: 16, resId: 'inner', xmlContent: '', sessionId: '' }],
        subMsgs: [
          {
            msgId: 89n,
            senderUin: 789,
            sendNick: '内部作者',
            sendTime: 1,
            elements: [{ elementType: 1, textContent: '本地深层正文' }],
          },
        ],
      },
    ],
    exportFetchForward: fetch,
  } as unknown as MsgService;
  const exported = message();
  await expandForwards(msgs, 'group', exported);
  expect(elementsToText(exported.elements)).toContain('本地深层正文');
  expect(fetch).not.toHaveBeenCalled();
});

it('本地缓存缺失时复用在线合并转发接口，递归导出内部正文且不重复拉取已展开卡片', async () => {
  const fetch = vi.fn(
    async (resId: string): Promise<FetchedForwardRecord[]> => [
      {
        msgId: '2',
        sendNick: '转发者',
        sendTime: '2',
        elements:
          resId === 'outer'
            ? [card('inner')]
            : [{ type: 'text', data: { textContent: '深层转发正文' } }],
      },
    ],
  );
  const msgs = { listForward: async () => [], exportFetchForward: fetch } as unknown as MsgService;
  const exported = message();
  await expandForwards(msgs, 'group', exported);
  expect(elementsToText(exported.elements)).toContain('深层转发正文');
  await expandForwards(msgs, 'group', exported);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('递归资源循环有界，离线或请求失败仍保留合并转发卡片', async () => {
  const fetch = vi.fn(
    async (): Promise<FetchedForwardRecord[]> => [{ msgId: '2', elements: [card('outer')] }],
  );
  const msgs = { listForward: async () => [], exportFetchForward: fetch } as unknown as MsgService;
  const exported = message();
  await expandForwards(msgs, 'group', exported);
  expect(fetch).toHaveBeenCalledOnce();
  expect(elementsToText(exported.elements)).toContain('[合并转发]');
  msgs.exportFetchForward = async () => {
    throw new Error('offline');
  };
  await expect(expandForwards(msgs, 'group', message())).resolves.toBeUndefined();
});

it('转发内部媒体进入扫描、路径标注和系统表情收集', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-forward-export-'));
  roots.push(root);
  const pic = {
    type: 'pic',
    data: {
      fileName: 'inside.jpg',
      fileToken: '',
      originalUrl: '',
      uploadTime: 0,
      uploadTimestamp: 0,
      fileTTL: 0,
    },
  } as RenderElement;
  const exported = message();
  const forward = exported.elements[0]!;
  if (forward.type !== 'multiMsg') throw new Error('fixture');
  forward.data.forwardMessages = [
    {
      senderName: '内部发言者',
      senderUin: '456',
      sendTime: 2,
      elements: [pic, { type: 'face', data: { faceId: 14 } } as RenderElement],
    },
  ];
  const row = {
    ...exported,
    msgId: 1n,
    msgSeq: 1n,
    sendTime: 1n,
    senderUin: 123n,
    targetGroupCode: '777',
  } as RenderGroupMsg;
  const msgs = {
    getGroupAfter: async () => [row],
    getGroupSeqlessAfterRowId: async () => [],
    listForward: async () => [],
  } as unknown as MsgService;
  const scan = await scanConvMedia(msgs, 'group', '777', mediaDirsFromNtDataDir(root));
  expect(scan.totalRefs).toBe(1);
  expect(scan.missing[0]?.msgId).toBe('1');
  annotateExportPaths(exported.elements);
  expect(pic.data).toHaveProperty('exportPath', 'media/image/inside.jpg');
  const faces = new Set<string>();
  collectFaceIds(exported.elements, faces);
  expect(faces.has('14')).toBe(true);
});

it('在线转发内部的视频复用渲染元素转换，不错误下载承载消息自己的附件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-forward-video-'));
  roots.push(root);
  const exported = message();
  const forward = exported.elements[0]!;
  if (forward.type !== 'multiMsg') throw new Error('fixture');
  forward.data.forwardMessages = [
    {
      msgId: '88',
      senderName: '内部发言者',
      senderUin: '456',
      sendTime: 2,
      elements: [
        {
          type: 'video',
          data: {
            fileName: 'forward.mp4',
            fileToken: 'forward-token',
            uploadTime: 0,
            uploadTimestamp: 0,
            fileTTL: 0,
            expireTimestamp: 0,
          },
        } as RenderElement,
      ],
    },
  ];
  const getRawElements = vi.fn(async () => null);
  const msgs = {
    getGroupAfter: async () => [
      { ...exported, msgId: 1n, msgSeq: 1n, sendTime: 1n, senderUin: 123n, targetGroupCode: '777' },
    ],
    getGroupSeqlessAfterRowId: async () => [],
    getRawElements,
    listForward: async () => [],
    findForwardedMediaElement: async () => null,
  } as unknown as MsgService;
  const scan = await scanConvMedia(msgs, 'group', '777', mediaDirsFromNtDataDir(root));
  expect(scan.downloadList[0]?.forwardMsgId).toBe('88');
  const resolve = vi.fn(async () => '');
  const mediaUrl = { getGroupVideoUrlFromElement: resolve } as unknown as Parameters<
    typeof downloadMissingVideos
  >[2]['mediaUrl'];
  await downloadMissingVideos(scan, root, { msgs, mediaUrl, kind: 'group', conv: '777' });
  expect(resolve).toHaveBeenCalledWith(
    777,
    expect.objectContaining({ fileToken: 'forward-token', fileName: 'forward.mp4' }),
  );
  expect(getRawElements).not.toHaveBeenCalled();
});
