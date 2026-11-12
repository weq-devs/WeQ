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
import { exportJsonConversation } from '../src/account/export/json_meta_exporter';
import { exportToHtml } from '../src/account/export/html_exporter';
import { exportToChatlab } from '../src/account/export/chatlab_exporter';
import { exportGroupToCsv } from '../src/account/export/csv_exporter';
import { exportToXlsx } from '../src/account/export/xlsx_exporter';
import { MessageJournal } from '../src/account/export/message_journal';
import ExcelJS from 'exceljs';

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

it('实际 TXT 文件直接输出内部消息，不保留承载消息的作者、时间或卡片包装', async () => {
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
  const result = await exportConversationToTxt(msgs, { kind: 'c2c', conv: 'peer', outputPath });
  const output = readFileSync(outputPath, 'utf8');
  expect(output).toContain('内部作者');
  expect(output).toContain('深层完整正文');
  expect(output).toContain('2023');
  expect(output).not.toContain('不应导出的外层文字');
  expect(output).not.toContain('123');
  expect(output).not.toContain('1970');
  expect(output.match(/\[聊天记录\]/g)).toHaveLength(1);
  expect(result.messageCount).toBe(1);
});

it.each([true, false])(
  'JSON（旧格式=%s）把内部消息作为独立记录并正确计数',
  async (legacyFormat) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-record-json-'));
    roots.push(root);
    const msgs = {
      exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 0, resId: 'outer' } },
      getC2cAfter: async () => [
        {
          msgId: 1n,
          msgSeq: 1n,
          senderUid: 'u_carrier',
          senderUin: 123n,
          sendTime: 1n,
          elements: [card('outer')],
        },
      ],
      getC2cSeqlessAfterRowId: async () => [],
      listForward: async () => [],
      exportFetchForward: async (): Promise<FetchedForwardRecord[]> => [
        {
          msgId: '9',
          senderUid: 'u_inside',
          senderUin: '456',
          sendNick: '内部作者',
          sendTime: '42',
          elements: [{ type: 'text', data: { textContent: '第一条正文' } }],
        },
        {
          msgId: '',
          senderUin: '789',
          sendNick: '另一作者',
          sendTime: '43',
          elements: [{ type: 'text', data: { textContent: '第二条正文' } }],
        },
      ],
      exportSourceRows: vi.fn(async () => {
        throw new Error('内部消息不能按承载会话查询原始行');
      }),
    } as unknown as MsgService;
    const outputPath = join(root, 'record.json');
    const result = await exportJsonConversation(msgs, {
      kind: 'c2c',
      conv: 'peer',
      outputPath,
      format: 'json',
      legacyFormat,
    });
    const output = readFileSync(outputPath, 'utf8');
    expect(result.messageCount).toBe(2);
    expect(output).toContain('第一条正文');
    expect(output).toContain('第二条正文');
    expect(output).toContain('内部作者');
    expect(output).toContain('另一作者');
    expect(output).not.toContain('u_carrier');
    expect(output).not.toContain('multiMsg');
    expect(msgs.exportSourceRows).not.toHaveBeenCalled();
    if (legacyFormat) {
      const records = JSON.parse(output).messages;
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        msgId: '9',
        senderUid: 'u_inside',
        senderUin: '456',
        senderName: '内部作者',
        sendTime: 42,
        msgSeq: '0',
      });
      expect(records[1].msgId).not.toBe(records[0].msgId);
    }
  },
);

it.each(['txt', 'html', 'csv', 'xlsx', 'chatlab', 'jsonl', 'archive-jsonl'] as const)(
  '%s 导出以内部消息为顶层，重复消息 ID 和同作者不同昵称不丢失',
  async (format) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-record-formats-'));
    roots.push(root);
    const row = {
      msgId: 1n,
      msgSeq: 1n,
      targetGroupCode: '777',
      senderUid: 'u_carrier',
      senderUin: 123n,
      sendTime: 1n,
      msgRandom: 99n,
      elements: [card('outer')],
    };
    const records: FetchedForwardRecord[] = ['第一位作者', '第二个昵称'].map((sendNick, index) => ({
      msgId: '9',
      senderUid: 'u_inside',
      senderUin: '456',
      sendNick,
      sendTime: String(42 + index),
      elements: [{ type: 'text', data: { textContent: `内部正文${index}` } }],
    }));
    const msgs = {
      exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 0, resId: 'outer' } },
      getGroupAfter: async () => [row],
      getGroupSeqlessAfterRowId: async () => [],
      listForward: async () => [],
      exportFetchForward: async () => records,
      // 格式器会重放封存后的进度文件，不能再次把内部记录当承载消息展开。
      exportJournal: new MessageJournal(join(root, 'messages.jsonl'), undefined, true),
    } as unknown as MsgService;
    const outputPath = join(root, `record.${format === 'xlsx' ? 'xlsx' : 'txt'}`);
    const opts = { kind: 'group' as const, conv: '777', groupCode: '777', outputPath };
    const result =
      format === 'txt'
        ? await exportConversationToTxt(msgs, opts)
        : format === 'html'
          ? await exportToHtml(msgs, opts)
          : format === 'csv'
            ? await exportGroupToCsv(msgs, opts)
            : format === 'xlsx'
              ? await exportToXlsx(msgs, opts)
              : format === 'chatlab'
                ? await exportToChatlab(msgs, { ...opts, format: 'json' })
                : await exportJsonConversation(msgs, {
                    ...opts,
                    format: 'jsonl',
                    legacyFormat: format === 'jsonl',
                    archive: { profile: 'full' },
                  });
    expect(result.messageCount).toBe(2);
    let output: string;
    if (format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(outputPath);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.rowCount).toBe(3);
      expect(sheet.getRow(2).getCell(2).value).toBe('456');
      output = JSON.stringify(sheet.getSheetValues());
    } else output = readFileSync(outputPath, 'utf8');
    expect(output).toContain('内部正文0');
    expect(output).toContain('内部正文1');
    expect(output).not.toContain('u_carrier');
    expect(output).not.toContain('multiMsg');
    if (format !== 'csv' && format !== 'xlsx') {
      expect(output).toContain('第一位作者');
      expect(output).toContain('第二个昵称');
    }
    if (format === 'archive-jsonl') {
      const messages = output
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.record?.kind === 'message');
      expect(messages).toHaveLength(2);
      expect(messages[0].record.id).not.toBe(messages[1].record.id);
      expect(output).not.toContain('msgRandom');
    }
    expect(msgs.exportJournal?.count).toBe(1);
  },
);

it('普通会话导出仍保留承载消息及完整的聊天记录卡片', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-record-normal-'));
  roots.push(root);
  const msgs = {
    getC2cAfter: async () => [
      {
        msgId: 1n,
        msgSeq: 1n,
        senderUid: 'u_carrier',
        senderUin: 123n,
        sendTime: 1n,
        elements: [card('outer')],
      },
    ],
    getC2cSeqlessAfterRowId: async () => [],
    listForward: async () => [
      { sendNick: '内部作者', elements: [{ elementType: 1, textContent: '内部正文' }] },
    ],
  } as unknown as MsgService;
  const outputPath = join(root, 'normal.txt');
  const result = await exportConversationToTxt(msgs, { kind: 'c2c', conv: 'peer', outputPath });
  const output = readFileSync(outputPath, 'utf8');
  expect(result.messageCount).toBe(1);
  expect(output).toContain('123');
  expect(output).toContain('[聊天记录]');
  expect(output).toContain('内部正文');
});

it.each(['official', 'service'] as const)('%s 的 Ark 卡片仍只导出选中的记录', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'weq-record-ark-'));
  roots.push(root);
  const page = async () =>
    ['other', 'outer'].map((resId, index) => ({
      msgId: BigInt(index),
      msgSeq: BigInt(index + 1),
      senderUid: 'u_carrier',
      senderUin: 123n,
      sendTime: 1n,
      elements: [
        {
          type: 'ark',
          data: {
            arkData: JSON.stringify({
              app: 'com.tencent.multimsg',
              meta: { detail: { resid: resId } },
            }),
          },
        },
      ],
    }));
  const fetch = vi.fn(
    async (resId: string): Promise<FetchedForwardRecord[]> => [
      {
        msgId: '9',
        senderUin: '456',
        sendNick: '内部作者',
        sendTime: '42',
        elements: [{ type: 'text', data: { textContent: `选中的正文 ${resId}` } }],
      },
    ],
  );
  const msgs = {
    exportFilter: { messageIds: ['1'], forwardTarget: { elementIndex: 0, resId: 'outer' } },
    getC2cAfter: page,
    getServiceAfter: page,
    getC2cSeqlessAfterRowId: async () => [],
    getServiceSeqlessAfterRowId: async () => [],
    listForward: async () => [],
    exportFetchForward: fetch,
  } as unknown as MsgService;
  const outputPath = join(root, 'record.txt');
  const result = await exportConversationToTxt(msgs, { kind, conv: 'peer', outputPath });
  expect(result.messageCount).toBe(1);
  expect(readFileSync(outputPath, 'utf8')).toContain('内部作者');
  expect(fetch.mock.calls.every((args) => args[0] === 'outer')).toBe(true);
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
