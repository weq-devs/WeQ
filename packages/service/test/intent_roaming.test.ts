import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { GapFetchedMessage } from '../src/account/gap_history';
import { IntentSenseService, type IntentLocalEnginePort } from '../src/account/intent_sense';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weq-intent-roaming-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function roaming(seq: number, extra: Partial<GapFetchedMessage> = {}): GapFetchedMessage {
  return {
    kind: 'c2c',
    conv: 'u_peer',
    msgId: '77',
    msgSeq: String(seq),
    senderUid: 'u_peer',
    senderUin: '22222',
    sendTime: String(1000 + seq),
    ntSeqVerified: true,
    elements: [{ type: 'text', data: { textContent: `漫游正文${seq}` } }],
    ...extra,
  };
}

async function fixture(rows: GapFetchedMessage[]) {
  const local = {
    msgId: 10n,
    msgSeq: 1n,
    targetUid: 'u_peer',
    targetGroupCode: '12345',
    senderUid: 'u_peer',
    senderUin: 22222n,
    sendTime: 1001n,
    elements: [{ kind: 'text', textContent: '本地上文' }],
  };
  const repository = {
    listLatest: vi.fn(async () => [local]),
    listBefore: vi.fn(async (_conv: unknown, seq: bigint) => (local.msgSeq < seq ? [local] : [])),
    listByMsgIds: vi.fn(async (ids: bigint[]) => (ids.includes(local.msgId) ? [local] : [])),
  };
  const session = {
    context: { uin: 10000n },
    uidMap: { sortNoByUid: () => 7 },
    c2cMsgs: repository,
    groupMsgs: repository,
  } as unknown as AccountSession;
  const cachedTimeline = vi.fn(async (_kind: string, _conv: string, start: number, end: number) =>
    rows.filter((row) => Number(row.msgSeq) >= start && Number(row.msgSeq) <= end),
  );
  const analyze = vi.fn<IntentLocalEnginePort['analyze']>(async () => ({
    intent: 'chat',
    emotion: 'neutral',
    intensity: 20,
    sentiment: 0,
    confidence: 0.8,
  }));
  const service = new IntentSenseService(session, dir, {
    localEngine: { ready: true, analyze, inferMbti: async () => null },
    gapHistory: { cachedTimeline },
    resolveEndpoint: () => ({
      baseUrl: 'https://synthetic.invalid',
      apiKey: 'synthetic',
      model: 'synthetic',
    }),
  });
  await service.setConfig({ enabled: true, engine: 'local' });
  return { service, analyze, cachedTimeline, repository, local };
}

it.each(['c2c', 'group'] as const)(
  '%s 自动分析合并本地与漫游，重复 random 不混淆不同序号，结果身份与聊天区一致',
  async (kind) => {
    const conv = kind === 'c2c' ? 'u_peer' : '12345';
    const f = await fixture([
      roaming(2, { kind, conv }),
      roaming(3, { kind, conv, sourceFormat: 'protocol' }),
      roaming(4, { kind, conv, sourceFormat: 'native', msgId: '999999999999999999' }),
    ]);
    const event = vi.fn();
    f.service.onAnalyzed(event);
    const stats = await f.service.ensureAnalysis(kind, conv);
    expect(stats.analyzed).toBe(4);
    expect(stats.latestMsgId).toBe('roaming:native:4:999999999999999999');
    expect(f.service.listMessageAnalyses(kind, conv).map((row) => row.msgId)).toEqual([
      '10',
      'roaming:2:77',
      'roaming:protocol:3:77',
      'roaming:native:4:999999999999999999',
    ]);
    expect(f.analyze.mock.calls[1]?.[1]?.context?.map((turn) => turn.text)).toEqual(['本地上文']);
    expect(event).toHaveBeenCalled();
    expect((await f.service.ensureAnalysis(kind, conv)).analyzed).toBe(0);
    expect(f.analyze).toHaveBeenCalledTimes(4);
  },
);

it('悬停旧漫游消息按会话、序号和消息 ID 精确读取，并附带当时的本地与漫游上文', async () => {
  const f = await fixture([roaming(2), roaming(3, { sourceFormat: 'protocol' })]);
  f.repository.listLatest.mockResolvedValue(
    Array.from({ length: 61 }, (_, index) => ({
      ...f.local,
      msgId: BigInt(100 + index),
      msgSeq: BigInt(100 + index),
      sendTime: BigInt(1100 + index),
    })).reverse(),
  );
  const result = await f.service.analyzeMessage('c2c', 'u_peer', 'roaming:protocol:3:77');
  expect(result?.msgId).toBe('roaming:protocol:3:77');
  expect(f.analyze.mock.calls[0]?.[1]?.context?.map((turn) => turn.text)).toEqual([
    '本地上文',
    '漫游正文2',
  ]);
  expect(f.repository.listByMsgIds).not.toHaveBeenCalled();
});

it('错误会话、未验证私聊序号、同序号错误 ID 和非法身份不会分析', async () => {
  const f = await fixture([
    roaming(2, { conv: 'u_other' }),
    roaming(3, { ntSeqVerified: false }),
    roaming(4),
  ]);
  for (const msgId of [
    'roaming:2:77',
    'roaming:3:77',
    'roaming:4:78',
    'roaming:0:77',
    'roaming:4294967296:77',
    'roaming:protocol:bad:77',
  ])
    expect(await f.service.analyzeMessage('c2c', 'u_peer', msgId)).toBeNull();
  expect(f.analyze).not.toHaveBeenCalled();
});

it('漫游和本地重复时沿用聊天区去重，媒体与引用预览不作为正文', async () => {
  const f = await fixture([
    roaming(1),
    roaming(2, {
      elements: [
        {
          type: 'reply',
          data: {
            origMsgId: 10n,
            origMsgSeq: 1,
            origMsgTime: 1001,
            origSenderUid: 'u_peer',
            origSenderUin: 22222,
            origMsgIndex: 0,
            origElements: [{ type: 'text', data: { textContent: '只在引用里' } }],
          },
        },
      ],
    }),
    roaming(3, { elements: [{ type: 'face', data: { faceText: '微笑', faceId: 14 } }] }),
  ]);
  const stats = await f.service.ensureAnalysis('c2c', 'u_peer');
  expect(stats.analyzed).toBe(2);
  expect(f.analyze.mock.calls.map(([text]) => text)).toEqual(['本地上文', '微笑']);
});

it('自动分析范围与零条上文对漫游同样生效，范围外仍可悬停', async () => {
  const f = await fixture([roaming(2), roaming(3, { msgId: '-77' })]);
  await f.service.setConfig({ analysisContextMessages: 0 });
  expect((await f.service.ensureAnalysis('c2c', 'u_peer', 1)).analyzed).toBe(1);
  expect(f.service.listMessageAnalyses('c2c', 'u_peer').map((row) => row.msgId)).toEqual([
    'roaming:3:-77',
  ]);
  expect((await f.service.analyzeMessage('c2c', 'u_peer', 'roaming:2:77'))?.msgId).toBe(
    'roaming:2:77',
  );
  expect(f.analyze.mock.calls.every(([, options]) => options?.context?.length === 0)).toBe(true);
});

it('API 分析保留漫游身份，并发送正确的正文与独立上文', async () => {
  const f = await fixture([roaming(2, { sourceFormat: 'protocol' })]);
  const fetch = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [{ i: 0, intent: 'chat', emotion: 'neutral' }],
                }),
              },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await f.service.setConfig({
    engine: 'api',
    providerRef: { providerId: 'fixture', model: 'synthetic' },
  });
  const result = await f.service.analyzeMessage('c2c', 'u_peer', 'roaming:protocol:2:77');
  expect(result).toMatchObject({ msgId: 'roaming:protocol:2:77', engine: 'api', mine: false });
  expect(f.analyze).not.toHaveBeenCalled();
  const input = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(JSON.parse(input.messages[1].content).messages[0]).toMatchObject({
    text: '漫游正文2',
    context: [{ speaker: '对方', text: '本地上文' }],
  });
});

it('自己的漫游消息遵循自己发送后分析开关，缓存故障不阻断本地分析', async () => {
  const f = await fixture([roaming(2, { senderUid: 'u_self', senderUin: '10000' })]);
  await f.service.setConfig({ analyzeAfterSelf: false });
  expect(await f.service.analyzeMessage('c2c', 'u_peer', 'roaming:2:77')).toBeNull();
  expect((await f.service.ensureAnalysis('c2c', 'u_peer')).skipped).toBe('disabled');
  expect(f.analyze).not.toHaveBeenCalled();
  f.cachedTimeline.mockRejectedValue(new Error('fixture-cache-unavailable'));
  expect((await f.service.ensureAnalysis('c2c', 'u_peer')).analyzed).toBe(1);
});

it('显示开关默认开启，独立持久化且不清空分析缓存或重跑模型', async () => {
  const f = await fixture([roaming(2)]);
  expect(f.service.getStatus()).toMatchObject({ persistentDisplay: true, hoverDisplay: true });
  await f.service.ensureAnalysis('c2c', 'u_peer');
  const revision = f.service.getStatus().analysisRevision;
  const before = f.service.listMessageAnalyses('c2c', 'u_peer');
  await f.service.setConfig({ persistentDisplay: false });
  expect(f.service.getStatus()).toMatchObject({
    persistentDisplay: false,
    hoverDisplay: true,
    analysisRevision: revision,
  });
  await f.service.setConfig({ hoverDisplay: false });
  expect(f.service.listMessageAnalyses('c2c', 'u_peer')).toEqual(before);
  const reopened = new IntentSenseService({} as AccountSession, dir);
  expect(reopened.getStatus()).toMatchObject({ persistentDisplay: false, hoverDisplay: false });
  expect((await f.service.ensureAnalysis('c2c', 'u_peer')).analyzed).toBe(0);
  expect(f.analyze).toHaveBeenCalledTimes(2);
});
