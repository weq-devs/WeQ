/**
 * IntentSenseService 单测：钉住三个核心约定 ——
 *   1. 配置归一化与会话覆盖语义（effectiveFor）；
 *   2. ensureAnalysis 增量语义（缓存命中的消息绝不重跑引擎，只补缺口）；
 *   3. api 引擎的结构化 JSON 解析防御（围栏/越界枚举/数值钳制/序号越界丢弃）。
 *
 * session 用结构化桩：服务只用 c2cMsgs/groupMsgs/uidMap/context.uin 五个面，
 * 不需要真的 AccountSession。fetch 全局打桩驱动 api 批处理分支。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntentSenseService,
  MAX_SUGGESTION_HISTORY,
  type IntentLocalEnginePort,
  type IntentAnalysisProgress,
} from '../src/account/intent_sense';
import { detectUpstreamSignal, analyzePragmatics } from '../src/account/intent_corpus';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { JsonStore } from '../src/common/json_store';
import type { AccountSession } from '@weq/account';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
  INTENT_TUNING,
} from '../src/common/intent_context';

interface StubMsg {
  msgId: bigint;
  msgSeq: bigint;
  senderUid: string;
  senderUin: bigint;
  sendTime: bigint;
  elements: Array<
    | { kind: 'text' | 'at'; textContent: string; atTargetUid?: string }
    | { kind: 'face'; faceText: string }
  >;
}

function makeSession(msgs: StubMsg[], peerUid = 'u_peer') {
  return {
    context: { uin: 10000n },
    uidMap: { sortNoByUid: (uid: string) => (uid === peerUid ? 7 : undefined) },
    c2cMsgs: {
      listLatest: vi.fn(async (_partition: unknown, limit: number) =>
        [...msgs].reverse().slice(0, limit),
      ), // db 语义：新→旧
      listByMsgIds: vi.fn(async (ids: bigint[]) => msgs.filter((m) => ids.includes(m.msgId))),
    },
    groupMsgs: {
      listLatest: vi.fn(async (_group: unknown, limit: number) =>
        [...msgs].reverse().slice(0, limit),
      ),
      listByMsgIds: vi.fn(async (ids: bigint[]) => msgs.filter((m) => ids.includes(m.msgId))),
    },
  } as unknown as AccountSession;
}

function textMsg(msgId: bigint, senderUid: string, text: string, sendTime: number): StubMsg {
  return {
    msgId,
    msgSeq: msgId,
    senderUid,
    senderUin: senderUid === 'u_peer' ? 22222n : 10000n,
    sendTime: BigInt(sendTime),
    elements: [{ kind: 'text', textContent: text }],
  };
}

function makeLocalPort(analyze: IntentLocalEnginePort['analyze']): IntentLocalEnginePort {
  return {
    ready: true,
    analyze,
    inferMbti: async () => null,
  };
}

describe('IntentSenseService', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'weq-intent-sense-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('局部恢复可降低缓存偏好而不立即删除分析结果，普通配置仍沿用原裁剪行为', async () => {
    const count = INTENT_TUNING.cacheEntries.min + 1;
    const session = makeSession(
      Array.from({ length: count }, (_, index) =>
        textMsg(BigInt(index + 1), 'u_peer', `合成消息 ${index}`, 1000 + index),
      ),
    );
    const svc = new IntentSenseService(session, dir, {
      localEngine: makeLocalPort(async () => ({
        intent: 'chat',
        emotion: 'neutral',
        intensity: 20,
        sentiment: 0,
        confidence: 0.8,
      })),
    });
    await svc.setConfig({
      enabled: true,
      engine: 'local',
      analysisContextMessages: 0,
      backfillMessages: count,
    });
    await svc.ensureAnalysis('c2c', 'u_peer');
    expect(svc.listMessageAnalyses('c2c', 'u_peer')).toHaveLength(count);
    const path = join(dir, 'analysis/c2c_u_peer.json');
    const before = readFileSync(path, 'utf8');
    await svc.setConfig(
      { cacheEntries: INTENT_TUNING.cacheEntries.min },
      { preserveAnalysisResults: true },
    );
    expect(svc.getStatus().cacheEntries).toBe(INTENT_TUNING.cacheEntries.min);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(svc.listMessageAnalyses('c2c', 'u_peer')).toHaveLength(count);
    await svc.setConfig({ cacheEntries: INTENT_TUNING.cacheEntries.min });
    expect(svc.listMessageAnalyses('c2c', 'u_peer')).toHaveLength(INTENT_TUNING.cacheEntries.min);
  });

  it('最近推荐期限默认一分钟，支持自定和永不过期，重启保留且不清除生成缓存', async () => {
    const session = makeSession([textMsg(1n, 'u_peer', '你好', 100)]);
    const svc = new IntentSenseService(session, dir);
    expect(svc.getStatus().suggestionExpiryMinutes).toBe(
      INTENT_TUNING.suggestionExpiryMinutes.default,
    );
    const revision = svc.getStatus().suggestionRevision;
    for (const minutes of [5, 0, -1]) {
      await svc.setConfig({ suggestionExpiryMinutes: minutes });
      expect(svc.getStatus().suggestionRevision).toBe(revision);
      expect(new IntentSenseService(session, dir).getStatus().suggestionExpiryMinutes).toBe(
        minutes,
      );
    }
    for (const value of [
      -2,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      INTENT_TUNING.suggestionExpiryMinutes.max + 1,
    ]) {
      await expect(svc.setConfig({ suggestionExpiryMinutes: value })).rejects.toThrow();
    }
    expect(svc.getStatus().suggestionExpiryMinutes).toBe(-1);
  });

  it('三项模式缺省为自动，独立保存且重启保留；手动分析只接受明确菜单请求', async () => {
    const analyze = vi.fn(
      async () =>
        ({
          intent: 'chat',
          emotion: 'neutral',
          intensity: 20,
          sentiment: 0,
          confidence: 0.8,
        }) as const,
    );
    const session = makeSession([
      textMsg(1n, 'u_peer', '你好', 100),
      textMsg(2n, 'u_self', '你好呀', 101),
    ]);
    const svc = new IntentSenseService(session, dir, { localEngine: makeLocalPort(analyze) });
    expect(svc.getStatus()).toMatchObject({
      analysisMode: 'auto',
      profileMode: 'auto',
      suggestionMode: 'auto',
    });
    await svc.setConfig({
      enabled: true,
      engine: 'local',
      analysisMode: 'manual',
      profileMode: 'manual',
      suggestionMode: 'manual',
      suggestionsEnabled: true,
      analyzeAfterSelf: false,
    });
    expect(await svc.ensureAnalysis('c2c', 'u_peer')).toMatchObject({ skipped: 'disabled' });
    expect(await svc.analyzeMessage('c2c', 'u_peer', '1')).toBeNull();
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    expect(analyze).not.toHaveBeenCalled();
    expect(await svc.analyzeMessage('c2c', 'u_peer', '2', { manual: true })).toMatchObject({
      msgId: '2',
      mine: true,
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect((await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).length).toBeGreaterThan(
      0,
    );
    expect(new IntentSenseService(session, dir).getStatus()).toMatchObject({
      analysisMode: 'manual',
      profileMode: 'manual',
      suggestionMode: 'manual',
    });
    await svc.setConfig({ analysisMode: 'auto' });
    expect(svc.getStatus()).toMatchObject({
      analysisMode: 'auto',
      profileMode: 'manual',
      suggestionMode: 'manual',
    });
  });

  it('画像缓存读取不会加载消息或计算，进入页面后能读取已完成的画像', async () => {
    const session = makeSession([textMsg(1n, 'u_peer', '你好', 100)]);
    const svc = new IntentSenseService(session, dir);
    await svc.setConfig({
      profileEnabled: true,
      profileEngine: 'heuristic',
      profileMode: 'manual',
    });
    expect(await svc.getProfile('u_peer', { cachedOnly: true })).toBeNull();
    expect(session.c2cMsgs.listLatest).not.toHaveBeenCalled();
    const profile = await svc.getProfile('u_peer');
    expect(profile).not.toBeNull();
    vi.mocked(session.c2cMsgs.listLatest).mockClear();
    expect(await svc.getProfile('u_peer', { cachedOnly: true })).toEqual(profile);
    expect(session.c2cMsgs.listLatest).not.toHaveBeenCalled();
    await svc.setConfig({ profileMode: 'auto' });
    expect(await svc.getProfile('u_peer', { cachedOnly: true })).toEqual(profile);
  });

  it('统一回退列表按数量随机无重复抽取，开关和空列表禁用回退，配置重启保留', async () => {
    const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '你好', 100)]), dir);
    await svc.setConfig({
      suggestionsEnabled: true,
      suggestionFallbackTexts: ['  A  ', 'B', 'C', 'D'],
      suggestionCount: 3,
      loadingAnimation: false,
    });
    const round = await svc.getSuggestionRound('c2c', 'u_peer');
    expect(round?.suggestions).toHaveLength(3);
    expect(new Set(round?.suggestions.map((s) => s.text)).size).toBe(3);
    expect(round?.suggestions.every((s) => ['A', 'B', 'C', 'D'].includes(s.text))).toBe(true);
    expect(await svc.getSuggestionRound('c2c', 'u_peer')).toEqual(round);
    const reopened = new IntentSenseService(makeSession([]), dir);
    expect(reopened.getStatus()).toMatchObject({
      loadingAnimation: false,
      suggestionFallbackTexts: ['A', 'B', 'C', 'D'],
    });
    await svc.setConfig({ suggestionFallbackEnabled: false });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    await svc.setConfig({ suggestionFallbackEnabled: true, suggestionFallbackTexts: [] });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    await expect(svc.setConfig({ suggestionFallbackTexts: ['A', ' A '] })).rejects.toThrow();
    await expect(svc.setConfig({ suggestionFallbackTexts: [' '] })).rejects.toThrow();
    await expect(svc.setConfig({ suggestionHistoryLimit: -1 })).rejects.toThrow();
  });

  it('历史上限只在新增时裁剪，零不写历史但保留当前轮次与缓存，重启不裁剪旧历史', async () => {
    const session = makeSession([textMsg(1n, 'u_peer', '你好', 100)]);
    const svc = new IntentSenseService(session, dir);
    await svc.setConfig({ suggestionsEnabled: true, suggestionHistoryLimit: 3 });
    for (let i = 0; i < 3; i++) await svc.getSuggestionRound('c2c', 'u_peer', { refresh: true });
    await svc.setConfig({ suggestionHistoryLimit: 1 });
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(3);
    expect(new IntentSenseService(session, dir).getSuggestionHistory('c2c', 'u_peer')).toHaveLength(
      3,
    );
    await svc.getSuggestionRound('c2c', 'u_peer', { refresh: true });
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(1);
    await svc.setConfig({ suggestionHistoryLimit: 0 });
    const current = await svc.getSuggestionRound('c2c', 'u_peer', { refresh: true });
    expect(current?.suggestions.length).toBeGreaterThan(0);
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(1);
    expect(svc.getSuggestionDetails('c2c', 'u_peer', current!.id)?.entry).toEqual(current);
    expect(await svc.getSuggestionRound('c2c', 'u_peer')).toEqual(current);
    expect(new IntentSenseService(session, dir).getSuggestionHistory('c2c', 'u_peer')).toHaveLength(
      1,
    );
  });

  it('同一次请求生成概括与推荐，轮次保存实际模型、耗时、用量和完整 prompt，重启可查且不再请求', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            model: 'actual-model',
            usage: { prompt_tokens: 40, completion_tokens: 20 },
            choices: [
              {
                message: {
                  content:
                    '{"summary":"双方正在确认见面时间，最新消息询问是否有空。","replies":[{"text":"有空，几点？"}]}',
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const session = makeSession([textMsg(1n, 'u_peer', '明天有空吗？', 1000)]);
    const svc = new IntentSenseService(session, dir, {
      resolveEndpoint: () => ({
        baseUrl: 'http://fixture',
        apiKey: 'secret-not-in-trace',
        model: 'requested-model',
        providerId: 'p',
        providerName: '测试供应商',
      }),
    });
    await svc.setConfig({
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'p', model: 'requested-model' },
    });
    const first = await svc.getSuggestionRound('c2c', 'u_peer');
    expect(first).toMatchObject({
      summary: '双方正在确认见面时间，最新消息询问是否有空。',
      generation: {
        source: 'api',
        model: 'actual-model',
        providerId: 'p',
        providerName: '测试供应商',
        inputMessages: 1,
        durationMs: expect.any(Number),
        requestDurationMs: expect.any(Number),
        usage: { promptTokens: 40, completionTokens: 20, totalTokens: 60 },
      },
    });
    expect((await svc.getSuggestionRound('c2c', 'u_peer'))?.id).toBe(first?.id);
    const second = await svc.getSuggestionRound('c2c', 'u_peer', { refresh: true });
    expect(second?.suggestions).toEqual(first?.suggestions);
    expect(second?.id).not.toBe(first?.id);
    const reopened = new IntentSenseService(session, dir);
    const details = reopened.getSuggestionDetails('c2c', 'u_peer', first!.id);
    expect(details?.entry?.id).toBe(first?.id);
    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(details?.trace?.prompt).toEqual({
      system: request.messages[0].content,
      user: request.messages[1].content,
    });
    expect(details?.trace?.response).toContain('actual-model');
    expect(JSON.stringify(details)).not.toContain('secret-not-in-trace');
    expect(reopened.getSuggestionDetails('group', 'u_peer', first!.id)).toBeNull();
    expect(reopened.getSuggestionDetails('c2c', 'other', first!.id)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('输入读取及模型等待期间可查看同一轮详情与实时日志，完成后沿用轮次 ID', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const session = makeSession([textMsg(1n, 'u_peer', '明天有空吗？', 1000)]);
    const svc = new IntentSenseService(session, dir, {
      resolveEndpoint: () => ({ baseUrl: 'http://fixture', apiKey: 'secret', model: 'fixture' }),
    });
    await svc.setConfig({
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'p', model: 'fixture' },
    });
    const pending = svc.getSuggestionRound('c2c', 'u_peer');
    const preparing = svc.getSuggestionDetails('c2c', 'u_peer');
    expect(preparing?.progress?.status).toBe('running');
    const id = preparing!.progress!.id;
    expect(preparing?.trace?.logs?.[0]?.text).toContain('读取');
    expect(svc.getSuggestionDetails('group', 'u_peer')).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const waiting = svc.getSuggestionDetails('c2c', 'u_peer', id);
    expect(waiting?.progress?.stage).toBe('等待模型返回');
    expect(waiting?.entry?.generation?.model).toBe('fixture');
    expect(waiting?.trace?.prompt?.user).toContain('明天有空吗');
    expect(waiting?.trace?.logs?.map((line) => line.stage)).toContain('System Prompt');
    expect(JSON.stringify(waiting)).not.toContain('"secret"');
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toEqual([]);
    finish(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"summary":"确认时间","replies":["有空"]}' } }],
        }),
      ),
    );
    const completed = await pending;
    expect(completed?.id).toBe(id);
    const details = svc.getSuggestionDetails('c2c', 'u_peer', id);
    expect(details?.progress?.status).toBe('completed');
    expect(details?.entry?.summary).toBe('确认时间');
    expect(details?.trace?.logs?.at(-1)?.text).toContain('完成');
    expect(fetchMock).toHaveBeenCalledOnce();
    const reopened = new IntentSenseService(session, dir);
    expect(reopened.getSuggestionDetails('c2c', 'u_peer', id)?.trace?.logs).toEqual(
      details?.trace?.logs,
    );
  });

  it('本地候选不冒充模型概括，旧历史缺少详情仍可读取', async () => {
    const session = makeSession([textMsg(1n, 'u_peer', '你好', 1000)]);
    const svc = new IntentSenseService(session, dir);
    await svc.setConfig({ suggestionsEnabled: true });
    const round = await svc.getSuggestionRound('c2c', 'u_peer');
    expect(round?.summary).toBeUndefined();
    expect(round?.generation?.source).toBe('local');
    const { generation: _generation, ...legacy } = round!;
    writeFileSync(join(dir, 'suggestion-history/c2c_u_peer.json'), JSON.stringify([legacy]));
    rmSync(join(dir, 'suggestion-details/c2c_u_peer', `${legacy.id}.json`));
    const reopened = new IntentSenseService(session, dir);
    expect(reopened.getSuggestionDetails('c2c', 'u_peer', legacy.id)).toEqual({
      entry: legacy,
      trace: null,
    });
    writeFileSync(
      join(dir, 'suggestion-history/c2c_u_peer.json'),
      JSON.stringify([
        { ...legacy, summary: { invalid: true }, generation: { source: 'api', durationMs: -1 } },
      ]),
    );
    const corruptMetadata = new IntentSenseService(session, dir).getSuggestionHistory(
      'c2c',
      'u_peer',
    );
    expect(corruptMetadata).toHaveLength(1);
    expect(corruptMetadata[0]?.summary).toBeUndefined();
    expect(corruptMetadata[0]?.generation).toBeUndefined();
  });

  it.each(['stop', 'failure', 'config'] as const)(
    '在途详情在 %s 后保留日志并终止运行状态，不写入空历史',
    async (action) => {
      let reject!: (error: Error) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((_resolve, fail) => {
            reject = fail;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '你好', 1000)]), dir, {
        resolveEndpoint: () => ({ baseUrl: 'http://fixture', apiKey: 'fixture', model: 'fixture' }),
      });
      await svc.setConfig({
        suggestionsEnabled: true,
        suggestionFallbackEnabled: false,
        suggestionProviderRef: { providerId: 'p', model: 'fixture' },
      });
      const pending = svc.getSuggestionRound('c2c', 'u_peer');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const id = svc.getSuggestionDetails('c2c', 'u_peer')!.progress!.id;
      if (action === 'stop') svc.stopSuggestions('c2c', 'u_peer');
      if (action === 'config') await svc.setConfig({ suggestionContextMessages: 1 });
      if (action !== 'failure')
        expect(svc.getSuggestionDetails('c2c', 'u_peer', id)?.progress?.status).toBe('stopped');
      reject(new Error('合成请求失败'));
      expect(await pending).toBeNull();
      const details = svc.getSuggestionDetails('c2c', 'u_peer', id);
      expect(details?.progress?.status).toBe(action === 'failure' ? 'failed' : 'stopped');
      expect(details?.trace?.prompt?.user).toContain('你好');
      if (action === 'failure')
        expect(details?.trace?.logs?.at(-1)?.text).toContain('合成请求失败');
      expect(svc.getSuggestionHistory('c2c', 'u_peer')).toEqual([]);
      expect(existsSync(join(dir, 'suggestion-details'))).toBe(false);
    },
  );

  it('超出历史轮数时同步清理该轮请求详情，不删除其他文件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify({ replies: [{ text: '你好' }] }) } }],
            }),
          ),
      ),
    );
    const session = makeSession([textMsg(1n, 'u_peer', '你好', 1000)]);
    const svc = new IntentSenseService(session, dir, {
      resolveEndpoint: () => ({ baseUrl: 'http://fixture', apiKey: 'fixture', model: 'm' }),
    });
    await svc.setConfig({
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'p', model: 'm' },
    });
    const first = (await svc.getSuggestionRound('c2c', 'u_peer'))!;
    const traceDir = join(dir, 'suggestion-details/c2c_u_peer');
    const path = join(traceDir, `${first.id}.json`);
    expect(existsSync(path)).toBe(true);
    writeFileSync(join(traceDir, 'unrelated.json'), '{}');
    writeFileSync(
      join(dir, 'suggestion-history/c2c_u_peer.json'),
      JSON.stringify(
        Array.from({ length: MAX_SUGGESTION_HISTORY }, (_, i) =>
          i === 0 ? first : { ...first, id: `legacy-${i}` },
        ),
      ),
    );
    const reopened = new IntentSenseService(session, dir);
    await reopened.getSuggestionRound('c2c', 'u_peer', { refresh: true });
    expect(reopened.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(MAX_SUGGESTION_HISTORY);
    expect(reopened.getSuggestionDetails('c2c', 'u_peer', first.id)).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(traceDir, 'unrelated.json'))).toBe(true);
  });

  it.each(['http', 'empty'])(
    '模型 %s 失败时详情保存实际 prompt 与回退原因，不把模型概括配给本地候选',
    async (failure) => {
      const fetchMock = vi.fn(async () =>
        failure === 'http'
          ? new Response('{"error":{"message":"fixture-down"}}', { status: 500 })
          : new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ summary: '不应显示的概括', replies: [] }),
                    },
                  },
                ],
              }),
            ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '你好', 1000)]), dir, {
        resolveEndpoint: () => ({
          baseUrl: 'http://fixture',
          apiKey: 'fixture',
          model: 'attempted-model',
        }),
      });
      await svc.setConfig({
        suggestionsEnabled: true,
        suggestionProviderRef: { providerId: 'p', model: 'attempted-model' },
      });
      const round = await svc.getSuggestionRound('c2c', 'u_peer');
      expect(round?.generation).toMatchObject({
        source: 'fallback',
        model: 'attempted-model',
        requestDurationMs: expect.any(Number),
      });
      expect(round?.summary).toBeUndefined();
      const details = svc.getSuggestionDetails('c2c', 'u_peer', round!.id);
      expect(details?.trace?.prompt?.user).toContain('你好');
      expect(details?.trace?.error).toContain(
        failure === 'http' ? 'fixture-down' : '未返回有效候选',
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])('API 失败、冷却和空候选均遵守回退开关 %s', async (enabled) => {
    const fetchMock = vi.fn(async () => new Response('fixture-down', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '你好', 1000)]), dir, {
      resolveEndpoint: () => ({ baseUrl: 'http://fixture', apiKey: 'fixture', model: 'fixture' }),
    });
    await svc.setConfig({
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'p', model: 'fixture' },
      suggestionFallbackEnabled: enabled,
      suggestionFallbackTexts: ['回退一', '回退二'],
    });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toHaveLength(enabled ? 2 : 0);
    expect(await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toHaveLength(
      enabled ? 2 : 0,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    await svc.setConfig({ suggestionFallbackTexts: ['新回退'] });
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"replies":[]}' } }] })),
    );
    expect(await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toHaveLength(
      enabled ? 1 : 0,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const round = svc.getSuggestionHistory('c2c', 'u_peer')[0];
    if (enabled)
      expect(svc.getSuggestionDetails('c2c', 'u_peer', round!.id)?.trace?.error).toContain(
        '未返回有效候选',
      );
  });

  it('回退配置修改隔离在途结果，历史为零仍提供本轮 API 详情且不落盘', async () => {
    let finish!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        started();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '你好', 1000)]), dir, {
      resolveEndpoint: () => ({ baseUrl: 'http://fixture', apiKey: 'fixture', model: 'fixture' }),
    });
    await svc.setConfig({ suggestionsEnabled: true, suggestionHistoryLimit: 0 });
    const stale = svc.getSuggestionRound('c2c', 'u_peer');
    await entered;
    await svc.setConfig({ suggestionFallbackTexts: ['新的内容'] });
    finish(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"replies":[{"text":"旧配置结果"}]}' } }],
        }),
      ),
    );
    expect(await stale).toBeNull();
    const next = svc.getSuggestionRound('c2c', 'u_peer');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    // 请求准备包含异步资料读取，等到第二次 fetch 后再释放。
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    finish(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"replies":[{"text":"当前结果"}]}' } }],
        }),
      ),
    );
    const current = await next;
    expect(current?.suggestions[0]?.text).toBe('当前结果');
    expect(svc.getSuggestionDetails('c2c', 'u_peer', current!.id)?.trace?.response).toContain(
      '当前结果',
    );
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toEqual([]);
    expect(existsSync(join(dir, 'suggestion-details'))).toBe(false);
    expect(
      new IntentSenseService(makeSession([]), dir).getSuggestionDetails(
        'c2c',
        'u_peer',
        current!.id,
      ),
    ).toBeNull();
  });

  it('批次进度只统计实际缺口，含失败完成数，晚订阅可恢复在途范围', async () => {
    let finish!: (value: null) => void;
    const analyze = vi
      .fn<IntentLocalEnginePort['analyze']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(null);
    const svc = new IntentSenseService(
      makeSession([
        textMsg(1n, 'u_peer', '合成消息一', 1000),
        textMsg(2n, 'u_peer', '合成消息二', 1001),
      ]),
      dir,
      { localEngine: makeLocalPort(analyze) },
    );
    await svc.setConfig({ enabled: true, engine: 'local' });
    const events: IntentAnalysisProgress[] = [];
    const off = svc.onAnalysisProgress((event) => events.push(event));
    const task = svc.ensureAnalysis('c2c', 'u_peer');
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    expect(events[0]).toMatchObject({ total: 2, completed: 0, failed: 0, pendingIds: ['1', '2'] });
    const late = vi.fn();
    const offLate = svc.onAnalysisProgress(late);
    expect(late).toHaveBeenCalledWith(events[0]);
    finish(null);
    expect(await task).toMatchObject({ analyzed: 0, failed: 2 });
    expect(events.at(-1)).toMatchObject({ total: 2, completed: 2, failed: 2, pendingIds: [] });
    const after = vi.fn();
    svc.onAnalysisProgress(after)();
    expect(after).not.toHaveBeenCalled();
    off();
    offLate();
  });

  it.each(['local', 'api'] as const)(
    '%s 本地处理逐条更新内存及推送结果，再更新进度；整块只写盘一次，重试不重算成功项',
    async (engine) => {
      const result = {
        intent: 'chat' as const,
        emotion: 'neutral' as const,
        intensity: 20,
        sentiment: 0,
        confidence: 0.8,
      };
      let finish!: (value: typeof result) => void;
      const analyze = vi
        .fn<IntentLocalEnginePort['analyze']>()
        .mockResolvedValue(result)
        .mockResolvedValueOnce(result)
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('合成 API 故障，改用本地');
        }),
      );
      const svc = new IntentSenseService(
        makeSession([
          textMsg(1n, 'u_peer', '合成正文一', 1000),
          textMsg(2n, 'u_peer', '合成正文二', 1001),
          textMsg(3n, 'u_peer', '合成正文三', 1002),
        ]),
        dir,
        {
          localEngine: makeLocalPort(analyze),
          resolveEndpoint: () => ({
            baseUrl: 'https://synthetic.invalid',
            apiKey: 'synthetic',
            model: 'synthetic',
          }),
        },
      );
      await svc.setConfig({
        enabled: true,
        engine,
        providerRef: { providerId: 'synthetic', model: 'synthetic' },
      });
      const events: string[] = [];
      const publish = vi.fn((event: { results: { msgId: string }[] }) => {
        events.push(`result:${event.results.map((item) => item.msgId).join(',')}`);
      });
      svc.onAnalyzed(publish);
      svc.onAnalysisProgress((event) => events.push(`progress:${event.completed}/${event.failed}`));
      const save = vi.spyOn(JsonStore.prototype, 'save');
      const task = svc.ensureAnalysis('c2c', 'u_peer');
      try {
        await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(3));
        expect(publish).toHaveBeenCalledOnce();
        expect(svc.listMessageAnalyses('c2c', 'u_peer').map((item) => item.msgId)).toEqual(['1']);
        expect(events).toEqual(['progress:0/0', 'result:1', 'progress:1/0', 'progress:2/1']);
        expect(save).not.toHaveBeenCalled();
        finish(result);
        expect(await task).toMatchObject({ analyzed: 2, failed: 1 });
        expect(save).toHaveBeenCalledOnce();
        expect(
          JSON.parse(readFileSync(join(dir, 'analysis/c2c_u_peer.json'), 'utf8')).results.map(
            (item: { msgId: string }) => item.msgId,
          ),
        ).toEqual(['1', '3']);
        expect(await svc.ensureAnalysis('c2c', 'u_peer')).toMatchObject({
          cached: 2,
          analyzed: 1,
          failed: 0,
        });
        expect(analyze).toHaveBeenCalledTimes(4);
        expect(analyze.mock.calls[3]?.[0]).toBe('合成正文二');
      } finally {
        finish?.(result);
        await task;
        save.mockRestore();
      }
    },
  );

  it.each(['context', 'range'] as const)(
    '逐条显示后切换 %s：旧任务不写入迟到结果，已完成缓存按配置有效性收尾',
    async (change) => {
      const result = {
        intent: 'chat' as const,
        emotion: 'neutral' as const,
        intensity: 20,
        sentiment: 0,
        confidence: 0.8,
      };
      let finish!: (value: typeof result) => void;
      const analyze = vi
        .fn<IntentLocalEnginePort['analyze']>()
        .mockResolvedValueOnce(result)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
      const session = makeSession([
        textMsg(1n, 'u_peer', '合成正文一', 1000),
        textMsg(2n, 'u_peer', '合成正文二', 1001),
      ]);
      const svc = new IntentSenseService(session, dir, { localEngine: makeLocalPort(analyze) });
      await svc.setConfig({ enabled: true, engine: 'local' });
      const publish = vi.fn();
      svc.onAnalyzed(publish);
      const task = svc.ensureAnalysis('c2c', 'u_peer');
      try {
        await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
        expect(svc.listMessageAnalyses('c2c', 'u_peer').map((item) => item.msgId)).toEqual(['1']);
        await svc.setConfig(
          change === 'context' ? { analysisContextMessages: 0 } : { backfillMessages: 61 },
        );
        finish(result);
        expect((await task).skipped).toBe('config-changed');
        expect(publish).toHaveBeenCalledOnce();
        const reopened = new IntentSenseService(session, dir, {
          localEngine: makeLocalPort(analyze),
        });
        expect(reopened.listMessageAnalyses('c2c', 'u_peer').map((item) => item.msgId)).toEqual(
          change === 'context' ? [] : ['1'],
        );
      } finally {
        finish?.(result);
        await task;
      }
    },
  );

  it('推荐历史按实际输入末条定位，缓存命中不重复记轮，手动重算与重启保留历史', async () => {
    const messages = [textMsg(1n, 'u_peer', '合成问题？', 1000)];
    const session = makeSession(messages);
    const svc = new IntentSenseService(session, dir);
    await svc.setConfig({ suggestionsEnabled: true, suggestionProviderRef: null });
    const first = await svc.getSuggestions('c2c', 'u_peer');
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toMatchObject([
      {
        target: { msgId: '1', msgSeq: '1', senderUin: '22222', sendTime: 1000 },
        suggestions: first,
      },
    ]);
    await svc.getSuggestions('c2c', 'u_peer');
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(1);
    await svc.getSuggestions('c2c', 'u_peer', { refresh: true });
    expect(svc.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(2);
    expect(new Set(svc.getSuggestionHistory('c2c', 'u_peer').map((entry) => entry.id)).size).toBe(
      2,
    );
    expect(svc.getSuggestionHistory('group', 'u_peer')).toEqual([]);
    messages.push(textMsg(2n, 'u_peer', '合成新消息', 1001));
    await svc.getSuggestions('c2c', 'u_peer');
    expect(svc.getSuggestionHistory('c2c', 'u_peer')[0]?.target.msgSeq).toBe('2');
    const reopened = new IntentSenseService(session, dir);
    expect(reopened.getSuggestionHistory('c2c', 'u_peer')).toHaveLength(3);
    expect(reopened.getSuggestionHistory('c2c', 'u_peer')[0]?.target.msgId).toBe('2');
  });

  it.each([
    undefined,
    {},
    { providerRef: null, profileProviderRef: null, suggestionProviderRef: null },
  ])('新配置及旧空引用使用默认，三个功能开关保持关闭：%j', async (raw) => {
    if (raw) writeFileSync(join(dir, 'config.json'), JSON.stringify(raw));
    const service = new IntentSenseService(makeSession([]), dir);
    const expected = {
      providerRef: { useDefault: true },
      profileProviderRef: { useDefault: true },
      suggestionProviderRef: { useDefault: true },
      enabled: false,
      profileEnabled: false,
      suggestionsEnabled: false,
    };
    expect(service.getStatus()).toMatchObject(expected);
    await service.setConfig({
      providerRef: null,
      profileProviderRef: null,
      suggestionProviderRef: null,
    });
    expect(new IntentSenseService(makeSession([]), dir).getStatus()).toMatchObject(expected);
  });

  it('默认模型变更使分析缓存失效，空值使用默认而显式选择保持不变', async () => {
    let model: string | null = 'first';
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"results":[{"i":0,"intent":"chat","emotion":"neutral","confidence":0.9}]}',
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const options = {
      resolveEndpoint: (ref: import('@weq/agentlab').AgentLabModelSelection) => {
        const selected = 'useDefault' in ref ? model : ref.model;
        if (!selected) throw new Error('未设置默认模型');
        return {
          baseUrl: 'https://synthetic.invalid',
          apiKey: 'synthetic',
          model: selected,
          modelIdentity: selected,
        };
      },
    };
    const session = makeSession([textMsg(1n, 'u_peer', '合成消息', 1000)]);
    const svc = new IntentSenseService(session, dir, options);
    await svc.setConfig({ enabled: true, providerRef: { useDefault: true } });
    expect(await svc.analyzeMessage('c2c', 'u_peer', '1')).not.toBeNull();
    await svc.analyzeMessage('c2c', 'u_peer', '1');
    expect(fetch).toHaveBeenCalledTimes(1);
    model = 'second';
    await svc.analyzeMessage('c2c', 'u_peer', '1');
    expect(fetch).toHaveBeenCalledTimes(2);
    model = 'third';
    const reopened = new IntentSenseService(session, dir, options);
    expect(reopened.getStatus().providerRef).toEqual({ useDefault: true });
    await reopened.analyzeMessage('c2c', 'u_peer', '1');
    expect(fetch).toHaveBeenCalledTimes(3);
    model = null;
    expect(reopened.getStatus()).toMatchObject({
      providerRef: { useDefault: true },
      apiConfigured: false,
    });
    expect(await reopened.analyzeMessage('c2c', 'u_peer', '1')).toBeNull();
    await reopened.setConfig({ providerRef: null });
    model = 'fourth';
    expect(await reopened.analyzeMessage('c2c', 'u_peer', '1')).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
    await reopened.setConfig({ providerRef: { providerId: 'explicit', model: 'fixed' } });
    await reopened.analyzeMessage('c2c', 'u_peer', '1');
    model = 'fifth';
    await reopened.analyzeMessage('c2c', 'u_peer', '1');
    expect(fetch).toHaveBeenCalledTimes(5);
    const body = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body));
    expect(body.model).toBe('fixed');
  });

  it('默认模型更换期间迟到的分析不落缓存或发布', async () => {
    let model = 'first';
    let finish!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '合成消息', 1000)]),
      dir,
      {
        resolveEndpoint: () => ({
          baseUrl: 'https://synthetic.invalid',
          apiKey: 'synthetic',
          model,
          modelIdentity: model,
        }),
      },
    );
    await svc.setConfig({ enabled: true, providerRef: { useDefault: true } });
    const publish = vi.fn();
    const dispose = svc.onAnalyzed(publish);
    const running = svc.analyzeMessage('c2c', 'u_peer', '1');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    model = 'second';
    finish(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: '{"results":[{"i":0,"intent":"chat","emotion":"neutral"}]}' } },
          ],
        }),
      ),
    );
    expect(await running).toBeNull();
    expect(svc.getMessageAnalyses('c2c', 'u_peer', ['1'])).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    dispose();
  });

  it('画像不受意图分析缓存、开关和会话覆盖影响', async () => {
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '合成消息', Math.floor(Date.now() / 1000))]),
      dir,
      {
        localEngine: makeLocalPort(async () => ({
          intent: 'chat',
          emotion: 'joy',
          intensity: 100,
          sentiment: 100,
          confidence: 1,
        })),
      },
    );
    await svc.setConfig({
      enabled: true,
      engine: 'local',
      profileEnabled: true,
      profileEngine: 'heuristic',
    });
    const before = await svc.getProfile('u_peer');
    await svc.ensureAnalysis('c2c', 'u_peer');
    expect(await svc.getProfile('u_peer')).toMatchObject({
      affinity: before?.affinity,
      analyzedSamples: 0,
      trend: [],
    });
    svc.clearCache();
    await svc.setConfig({ enabled: false });
    await svc.setConversationOverride('c2c', 'u_peer', false);
    expect(await svc.getProfile('u_peer')).toMatchObject({
      affinity: before?.affinity,
      analyzedSamples: 0,
    });
  });

  it('旧跟随配置只迁移一次，画像模型不再跟随意图模型变化', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        featureSettingsVersion: 1,
        enabled: true,
        profileEnabled: true,
        engine: 'api',
        providerRef: { providerId: 'old', model: 'old-model' },
        profileEngine: 'follow',
      }),
    );
    const svc = new IntentSenseService(makeSession([]), dir);
    expect(svc.getStatus()).toMatchObject({
      profileEngine: 'api',
      profileProviderRef: { providerId: 'old', model: 'old-model' },
    });
    await svc.setConfig({
      providerRef: { providerId: 'new', model: 'new-model' },
      engine: 'local',
    });
    expect(new IntentSenseService(makeSession([]), dir).getStatus()).toMatchObject({
      profileEngine: 'api',
      profileProviderRef: { providerId: 'old', model: 'old-model' },
    });
  });

  it('画像使用自己的 API、温度和样本，不依赖分析开关或分析 API', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: 'profile-model',
        temperature: 0.6,
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  emotions: [
                    { index: 0, sentiment: 80, intensity: 60 },
                    { index: 0, sentiment: 80, intensity: 60 },
                    { index: 99, sentiment: -100, intensity: 100 },
                    { index: 1, sentiment: 'bad', intensity: 50 },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const resolveEndpoint = vi.fn((ref) => ({
      baseUrl: 'https://synthetic.invalid',
      apiKey: 'synthetic',
      model: ref.model,
    }));
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '合成样本', Math.floor(Date.now() / 1000))]),
      dir,
      { resolveEndpoint },
    );
    await svc.setConfig({
      enabled: false,
      providerRef: { providerId: 'analysis', model: 'analysis-model' },
      profileEnabled: true,
      profileEngine: 'api',
      profileProviderRef: { providerId: 'profile', model: 'profile-model' },
      profileMinSamples: 1,
      profileTemperature: 0.6,
    });
    expect(await svc.getProfile('u_peer')).toMatchObject({
      engine: 'api',
      analyzedSamples: 1,
      affinity: expect.any(Number),
    });
    expect(resolveEndpoint).toHaveBeenCalledWith({ providerId: 'profile', model: 'profile-model' });
    expect(svc.listMessageAnalyses('c2c', 'u_peer')).toEqual([]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('画像 API 默认等待 300 秒，保存与重开后不被旧上限截断', async () => {
    const timeoutSeconds = 300;
    const session = makeSession([textMsg(1n, 'u_peer', '合成样本', 1000)]);
    const options = {
      resolveEndpoint: () => ({
        baseUrl: 'https://synthetic.invalid',
        apiKey: 'synthetic',
        model: 'profile-model',
      }),
    };
    const svc = new IntentSenseService(session, dir, options);
    expect(svc.getStatus().profileApiTimeoutSeconds).toBe(timeoutSeconds);
    await svc.setConfig({
      profileEnabled: true,
      profileEngine: 'api',
      profileProviderRef: { providerId: 'profile', model: 'profile-model' },
      profileMinSamples: 1,
      profileApiTimeoutSeconds: timeoutSeconds,
    });
    const reopened = new IntentSenseService(session, dir, options);
    expect(reopened.getStatus().profileApiTimeoutSeconds).toBe(timeoutSeconds);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            { message: { content: '{"emotions":[{"index":0,"sentiment":60,"intensity":50}]}' } },
          ],
        }),
      ),
    );
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      expect(await reopened.getProfile('u_peer')).toMatchObject({ analyzedSamples: 1 });
      expect(timeout).toHaveBeenCalledWith(timeoutSeconds * 1000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('本地画像选择独立资源，不调用意图分析端口', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'joy' as const,
      intensity: 70,
      sentiment: 80,
      confidence: 1,
    }));
    const analysisPort = makeLocalPort(vi.fn(async () => null));
    const forModel = vi.fn(() => makeLocalPort(analyze));
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '本地合成样本', Math.floor(Date.now() / 1000))]),
      dir,
      { localEngine: { ...analysisPort, forModel } },
    );
    await svc.setConfig({
      profileEnabled: true,
      profileEngine: 'local',
      profileLocalModelId: 'laya-multilingual',
      profileMinSamples: 1,
    });
    expect(await svc.getProfile('u_peer')).toMatchObject({ engine: 'local', analyzedSamples: 1 });
    expect(forModel).toHaveBeenCalledWith('laya-multilingual');
    expect(analyze).toHaveBeenCalledOnce();
    expect(analysisPort.analyze).not.toHaveBeenCalled();
  });

  it('同一对方并发读取画像只运行一次推断', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'neutral' as const,
      intensity: 40,
      sentiment: 0,
      confidence: 1,
    }));
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '并发合成样本', 1000)]),
      dir,
      { localEngine: makeLocalPort(analyze) },
    );
    await svc.setConfig({ profileEnabled: true, profileEngine: 'local', profileMinSamples: 1 });
    const [a, b] = await Promise.all([svc.getProfile('u_peer'), svc.getProfile('u_peer')]);
    expect(a).toEqual(b);
    expect(analyze).toHaveBeenCalledOnce();
  });

  it('旧本地画像固化原资源与超时，保留关闭状态', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        featureSettingsVersion: 1,
        enabled: false,
        profileEnabled: false,
        engine: 'local',
        profileEngine: 'local',
        apiTimeoutSeconds: 55,
        apiCooldownSeconds: 66,
      }),
    );
    const svc = new IntentSenseService(makeSession([]), dir, {
      legacyLocalModelId: 'laya-multilingual',
    });
    expect(svc.getStatus()).toMatchObject({
      profileEngine: 'local',
      profileEnabled: false,
      profileLocalModelId: 'laya-multilingual',
      profileApiTimeoutSeconds: 55,
      profileApiCooldownSeconds: 66,
    });
    expect(await svc.getProfile('u_peer')).toBeNull();
  });

  it('意图设置和清缓存不废弃在途画像，画像设置变化会废弃旧结果', async () => {
    const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '合成样本', 1000)]), dir);
    await svc.setConfig({ profileEnabled: true, profileEngine: 'heuristic' });
    const revision = svc.getStatus().profileRevision;
    const pending = svc.getProfile('u_peer');
    await svc.setConfig({ enabled: true, analysisTemperature: 0.8 });
    svc.clearCache();
    expect(svc.getStatus().profileRevision).toBe(revision);
    expect(await pending).not.toBeNull();
    const stale = svc.getProfile('u_peer');
    const rejected = expect(stale).rejects.toThrow('互动画像设置已更改');
    await svc.setConfig({ profileTopicLimit: 3 });
    await rejected;
    expect(svc.getStatus().profileRevision).toBe(revision + 1);
  });

  it('画像 API 失败冷却不会被保存意图设置清除，也不转用意图 API', async () => {
    const fetch = vi.fn(async () => new Response('synthetic failure', { status: 500 }));
    vi.stubGlobal('fetch', fetch);
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '合成样本', 1000)]),
      dir,
      {
        resolveEndpoint: () => ({
          baseUrl: 'https://synthetic.invalid',
          apiKey: 'synthetic',
          model: 'profile',
        }),
      },
    );
    await svc.setConfig({
      profileEnabled: true,
      profileEngine: 'api',
      profileProviderRef: { providerId: 'synthetic', model: 'profile' },
      profileMinSamples: 1,
    });
    expect(await svc.getProfile('u_peer')).toMatchObject({ affinity: null, analyzedSamples: 0 });
    await svc.setConfig({ enabled: true, analysisTemperature: 0.8 });
    await svc.getProfile('u_peer');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { name: '没有消息', messages: [] },
    { name: '只有自己的消息', messages: [textMsg(1n, 'u_self', '自己发出的消息', 1000)] },
    { name: '对方只有空白文本', messages: [textMsg(1n, 'u_peer', ' \n\t ', 1000)] },
    {
      name: '对方只有不可分析元素',
      messages: [{ ...textMsg(1n, 'u_peer', '', 1000), elements: [] }],
    },
  ])('$name 时不生成画像，也不调用模型', async ({ messages }) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const inferMbti = vi.fn(async () => null);
    const svc = new IntentSenseService(makeSession(messages), dir, {
      localEngine: { ...makeLocalPort(async () => null), inferMbti },
      resolveEndpoint: () => ({
        baseUrl: 'https://synthetic.invalid',
        apiKey: 'synthetic',
        model: 'synthetic',
      }),
    });
    for (const profileEngine of ['heuristic', 'local', 'api'] as const) {
      await svc.setConfig({
        enabled: true,
        engine: 'api',
        providerRef: { providerId: 'synthetic', model: 'synthetic' },
        profileEnabled: true,
        profileEngine,
        profileProviderRef: { providerId: 'synthetic', model: 'synthetic' },
        profileMinSamples: 1,
      });
      expect(await svc.getProfile('u_peer')).toBeNull();
    }
    expect(inferMbti).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('当前消息已为空时，旧分析缓存不能凭空生成画像；新对方消息出现后恢复计算', async () => {
    const messages = [textMsg(1n, 'u_peer', '之前的对方消息', 1000)];
    const svc = new IntentSenseService(makeSession(messages), dir, {
      localEngine: makeLocalPort(async () => ({
        intent: 'chat',
        emotion: 'neutral',
        intensity: 20,
        sentiment: 0,
        confidence: 0.9,
      })),
    });
    await svc.setConfig({
      enabled: true,
      engine: 'local',
      profileEnabled: true,
      profileEngine: 'heuristic',
    });
    await svc.ensureAnalysis('c2c', 'u_peer');
    expect(await svc.getProfile('u_peer')).toMatchObject({
      sampled: 1,
      analyzedSamples: 0,
      affinity: null,
    });
    messages.length = 0;
    expect(await svc.getProfile('u_peer')).toBeNull();
    messages.push(textMsg(2n, 'u_self', '自己的新消息', 1020));
    expect(await svc.getProfile('u_peer')).toBeNull();
    messages.push(textMsg(3n, 'u_peer', '新的对方消息', 1040));
    expect(await svc.getProfile('u_peer')).toMatchObject({ sampled: 2, analyzedSamples: 0 });
  });

  it('读取失败保留错误，不将数据库错误冒充暂无消息', async () => {
    const session = makeSession([]);
    vi.mocked(session.c2cMsgs.listLatest).mockRejectedValue(new Error('合成数据库读取失败'));
    const svc = new IntentSenseService(session, dir);
    await svc.setConfig({ profileEnabled: true, profileEngine: 'heuristic' });
    await expect(svc.getProfile('u_peer')).rejects.toThrow('合成数据库读取失败');
  });

  it.each(['analysis', 'profile', 'suggestions'] as const)(
    '%s 真实 API 路径温度被拒后去参回退，不改设置且两次尝试独立记账',
    async (feature) => {
      const usage = new TokenUsageStore(join(dir, 'usage.json'));
      const response =
        feature === 'analysis'
          ? {
              results: [
                {
                  i: 0,
                  intent: 'chat',
                  emotion: 'neutral',
                  intensity: 20,
                  sentiment: 0,
                  confidence: 0.9,
                },
              ],
            }
          : feature === 'profile'
            ? {
                mbti: ['EI', 'SN', 'TF', 'JP'].map((key) => ({ key, leftPct: 60 })),
                topics: ['合成话题'],
              }
            : { replies: [{ text: '合成回退建议', tone: '简短' }] };
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            '{"error":{"param":"temperature","code":"unsupported_parameter","message":"Unsupported parameter: temperature"},"usage":{"total_tokens":1}}',
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(response) } }],
              usage: { total_tokens: 5 },
            }),
          ),
        );
      vi.stubGlobal('fetch', fetch);
      const svc = new IntentSenseService(
        makeSession([textMsg(1n, 'u_peer', '合成消息', 1000)]),
        dir,
        {
          resolveEndpoint: () => ({
            baseUrl: 'https://synthetic.invalid',
            apiKey: 'synthetic-key',
            model: 'synthetic-model',
            onUsage: (entry) =>
              usage.record({ ...entry, ts: entry.startedAt!, scope: entry.feature! }),
          }),
        },
      );
      const ref = { providerId: 'synthetic-provider', model: 'synthetic-model' };
      await svc.setConfig({
        enabled: true,
        engine: 'api',
        providerRef: ref,
        suggestionsEnabled: true,
        suggestionProviderRef: ref,
        profileEnabled: true,
        profileEngine: 'api',
        profileProviderRef: ref,
        profileMinSamples: 1,
        analysisTemperature: 0.1,
        profileTemperature: 0.2,
        suggestionTemperature: 0.3,
      });
      if (feature === 'analysis') {
        await svc.ensureAnalysis('c2c', 'u_peer');
        expect(svc.listMessageAnalyses('c2c', 'u_peer')).toHaveLength(1);
        await svc.ensureAnalysis('c2c', 'u_peer');
      } else if (feature === 'profile') {
        expect(await svc.getProfile('u_peer')).toMatchObject({
          engine: 'api',
          topics: [{ topic: '合成话题' }],
        });
      } else {
        expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([
          { text: '合成回退建议', tone: '简短' },
        ]);
        await svc.getSuggestions('c2c', 'u_peer');
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      const first = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body));
      const retry = JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body));
      const { temperature: _temperature, ...expected } = first;
      expect(first.temperature).toBe(
        feature === 'analysis' ? 0.1 : feature === 'profile' ? 0.2 : 0.3,
      );
      expect(retry).toEqual(expected);
      expect(svc.getStatus()).toMatchObject({
        analysisTemperature: 0.1,
        profileTemperature: 0.2,
        suggestionTemperature: 0.3,
      });
      expect(usage.getStats()).toMatchObject({
        totalCalls: 2,
        failedCalls: 1,
        totalTokens: 6,
        pendingCalls: 0,
      });
      expect(usage.getStats().byFeature[0]?.feature).toBe(
        feature === 'analysis'
          ? 'intent-analysis'
          : feature === 'profile'
            ? 'intent-profile'
            : 'reply-suggestion',
      );
    },
  );

  it.each(['api', 'local'] as const)(
    '真实 %s 分析路径仅记录实际 API 请求，缓存和本地引擎不混入 Token',
    async (engine) => {
      const usage = new TokenUsageStore(join(dir, 'usage.json'));
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content:
                      '{"results":[{"i":0,"intent":"chat","emotion":"neutral","intensity":20,"sentiment":0,"confidence":0.9}]}',
                  },
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            }),
          ),
      );
      vi.stubGlobal('fetch', fetch);
      const svc = new IntentSenseService(makeSession([textMsg(1n, 'u_peer', '测试', 1000)]), dir, {
        resolveEndpoint: () => ({
          baseUrl: 'https://fixture.invalid',
          apiKey: 'fixture',
          model: 'fixture',
          onUsage: (u) => usage.record({ ...u, ts: u.startedAt!, scope: u.feature! }),
        }),
        localEngine: makeLocalPort(async () => ({
          intent: 'chat',
          emotion: 'neutral',
          intensity: 20,
          sentiment: 0,
          confidence: 0.9,
        })),
      });
      await svc.setConfig({
        enabled: true,
        engine,
        providerRef: { providerId: 'fixture', model: 'fixture' },
      });
      await svc.ensureAnalysis('c2c', 'u_peer');
      await svc.ensureAnalysis('c2c', 'u_peer');
      expect(fetch).toHaveBeenCalledTimes(engine === 'api' ? 1 : 0);
      expect(usage.getStats()).toMatchObject({
        totalCalls: engine === 'api' ? 1 : 0,
        totalTokens: engine === 'api' ? 6 : 0,
      });
      if (engine === 'api') expect(usage.getStats().byFeature[0]?.feature).toBe('intent-analysis');
    },
  );

  it('分析上文按独立条数实际截取，修改后缓存失效，重开仍按当前条数识别缓存', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      textMsg(BigInt(i + 1), 'u_peer', `消息${i + 1}`, 1000 + i * 20),
    );
    const analyze = vi.fn(
      async (_text: string, _options?: Parameters<IntentLocalEnginePort['analyze']>[1]) => ({
        intent: 'chat' as const,
        emotion: 'neutral' as const,
        intensity: 20,
        sentiment: 0,
        confidence: 0.8,
      }),
    );
    const opts = { localEngine: makeLocalPort(analyze) };
    const svc = new IntentSenseService(makeSession(msgs), dir, opts);
    await svc.setConfig({
      enabled: true,
      engine: 'local',
      analysisContextMessages: 2,
      suggestionContextMessages: 1,
    });
    await svc.analyzeMessage('c2c', 'u_peer', '6');
    expect(analyze.mock.calls[0]?.[1]?.context?.map((row) => row.text)).toEqual(['消息4', '消息5']);
    await svc.setConfig({ analysisContextMessages: 0 });
    expect(svc.listMessageAnalyses('c2c', 'u_peer')).toEqual([]);
    await svc.analyzeMessage('c2c', 'u_peer', '6');
    expect(analyze.mock.calls[1]?.[1]?.context).toEqual([]);
    const reopened = new IntentSenseService(makeSession(msgs), dir, opts);
    await reopened.analyzeMessage('c2c', 'u_peer', '6');
    expect(analyze).toHaveBeenCalledTimes(2);
    await reopened.setConfig({ suggestionContextMessages: 0 });
    await reopened.analyzeMessage('c2c', 'u_peer', '6');
    expect(analyze).toHaveBeenCalledTimes(2);
    await reopened.setConfig({ analysisContextMessages: 2 });
    expect(reopened.listMessageAnalyses('c2c', 'u_peer')).toEqual([]);
    await reopened.analyzeMessage('c2c', 'u_peer', '6');
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it('推荐回复上文独立截取，包含当前消息，条数变化不复用旧建议', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      textMsg(BigInt(i + 1), 'u_peer', `消息${i + 1}`, 1000 + i * 20),
    );
    const requests: Array<{ messages: Array<{ text: string }> }> = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      requests.push(JSON.parse(body.messages[1]!.content));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"replies":[{"text":"合成建议"}]}' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({
        baseUrl: 'http://fixture',
        apiKey: 'fixture',
        model: ref.model,
      }),
    });
    await svc.setConfig({
      enabled: true,
      providerRef: { providerId: 'fixture', model: 'fixture' },
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
      analysisContextMessages: 0,
      suggestionContextMessages: 1,
    });
    await svc.getSuggestions('c2c', 'u_peer');
    expect(requests[0]?.messages.map((row) => row.text)).toEqual(['消息5', '消息6']);
    await svc.getSuggestions('c2c', 'u_peer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await svc.setConfig({ suggestionContextMessages: 3 });
    await svc.getSuggestions('c2c', 'u_peer');
    expect(requests[1]?.messages.map((row) => row.text)).toEqual([
      '消息3',
      '消息4',
      '消息5',
      '消息6',
    ]);
    await svc.setConfig({ suggestionContextMessages: 0 });
    await svc.getSuggestions('c2c', 'u_peer');
    expect(requests[2]?.messages.map((row) => row.text)).toEqual(['消息6']);
  });

  it.each(['local', 'roaming', 'missing-names'])(
    '%s 群上下文将真实发送者、@ 目标、名字和时间传入模型',
    async (source) => {
      const start = Date.parse('2026-10-24T12:00:00+08:00') / 1000;
      const msgs = [
        textMsg(1n, 'u_self', '我先问一下', start),
        textMsg(2n, 'u_peer', '我来回答', start + 10),
        textMsg(3n, 'u_other', '请看看', start + 20),
      ];
      msgs[2]!.senderUin = 33333n;
      msgs[2]!.elements.push(
        { kind: 'at', textContent: '@同名', atTargetUid: 'u_peer' },
        { kind: 'at', textContent: '@我', atTargetUid: 'u_self' },
        { kind: 'at', textContent: '@全体成员', atTargetUid: 'all' },
        { kind: 'at', textContent: '@未发言成员', atTargetUid: 'u_silent' },
      );
      const session = Object.assign(makeSession(source === 'roaming' ? [] : msgs), {
        selfUid: 'u_self',
        profileInfo: { profilesByUids: vi.fn(async () => []) },
        groupMembers: {
          getMembersByUids: vi.fn(async () => {
            if (source === 'missing-names') throw new Error('合成群资料读取失败');
            return [
              { uid: 'u_peer', uin: 22222n, card: '同名', nick: '' },
              { uid: 'u_other', uin: 33333n, card: '同名', nick: '' },
              { uid: 'u_silent', uin: 44444n, card: '未发言成员', nick: '' },
            ];
          }),
          getMembersByUins: vi.fn(async () => []),
        },
      });
      const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"replies":[{"text":"合成推荐"}]}' } }],
        }),
      }));
      vi.stubGlobal('fetch', fetchMock);
      const svc = new IntentSenseService(session, dir, {
        resolveEndpoint: (ref) => ({
          baseUrl: 'http://fixture',
          apiKey: 'fixture',
          model: ref.model,
        }),
        ...(source === 'roaming'
          ? {
              gapHistory: {
                cachedTimeline: vi.fn(async () =>
                  msgs.map((m) => ({
                    kind: 'group' as const,
                    conv: '123',
                    msgId: m.msgId.toString(),
                    msgSeq: m.msgSeq.toString(),
                    senderUid: m.senderUid,
                    senderUin: m.senderUin.toString(),
                    sendTime: m.sendTime.toString(),
                    elements: m.elements.map(({ kind, ...data }) => ({ type: kind, data })),
                  })),
                ),
              },
            }
          : {}),
      });
      await svc.setConfig({
        suggestionsEnabled: true,
        suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
        suggestionContextMessages: 5,
      });
      await svc.getSuggestions('group', '123');
      const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        messages: Array<{ content: string }>;
      };
      const context = JSON.parse(payload.messages[1]!.content);
      expect(context.messages).toHaveLength(3);
      expect(context.messages[0].sender).toMatchObject({ uid: 'u_self', isSelf: true });
      const name = source === 'missing-names' ? null : '同名';
      expect(context.messages[1].sender).toMatchObject({ uid: 'u_peer', name });
      expect(context.messages[2].sender).toMatchObject({ uid: 'u_other', name });
      expect(context.messages[2].sentAt).toBe('2026-10-24T12:00:20+08:00');
      expect(context.messages[2].text).toContain('@同名');
      expect(context.messages[2].mentions[0].target).toEqual(context.messages[1].sender);
      expect(context.messages[2].mentions[1].target).toMatchObject({ uid: 'u_self', isSelf: true });
      expect(context.messages[2].mentions[2].all).toBe(true);
      expect(context.messages[2].mentions[3].target).toMatchObject({
        uid: 'u_silent',
        name: source === 'missing-names' ? null : '未发言成员',
      });
      expect(session.groupMembers.getMembersByUids).toHaveBeenCalledWith(
        123n,
        expect.arrayContaining(['u_self', 'u_peer', 'u_other', 'u_silent']),
      );
    },
  );

  it('手动换一批绕过候选缓存和自己发送后自动推荐开关，但不覆盖功能及会话开关', async () => {
    const msgs = [textMsg(1n, 'u_peer', '合成对方消息', 1000)];
    let batch = 0;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                replies: [{ text: `第${++batch}批` }],
              }),
            },
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({
        baseUrl: 'http://fixture',
        apiKey: 'fixture',
        model: ref.model,
      }),
    });
    await svc.setConfig({
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
      suggestAfterSelf: false,
    });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([{ text: '第1批' }]);
    expect(await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toEqual([
      { text: '第2批' },
    ]);
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([{ text: '第2批' }]);
    msgs.push(textMsg(2n, 'u_self', '合成自己消息', 1020));
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    expect(await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toEqual([
      { text: '第3批' },
    ]);
    expect(svc.getStatus().suggestAfterSelf).toBe(false);
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    await svc.setConversationOverride('c2c', 'u_peer', false);
    expect(await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toEqual([]);
    await svc.setConversationOverride('c2c', 'u_peer', null);
    await svc.setConfig({ suggestionsEnabled: false });
    expect(await svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(['message', 'config', 'conversation'])(
    '手动换一批在 %s 改变后仅配置失效或关闭会话才丢弃结果',
    async (change) => {
      const msgs = [textMsg(1n, 'u_self', '合成自己消息', 1000)];
      const response = {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"replies":[{"text":"迟到候选"}]}' } }],
        }),
      };
      let finish!: (value: typeof response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const svc = new IntentSenseService(makeSession(msgs), dir, {
        resolveEndpoint: (ref) => ({
          baseUrl: 'http://fixture',
          apiKey: 'fixture',
          model: ref.model,
        }),
      });
      await svc.setConfig({
        suggestionsEnabled: true,
        suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
        suggestAfterSelf: false,
      });
      const pending = svc.getSuggestions('c2c', 'u_peer', { refresh: true });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      if (change === 'message') msgs.push(textMsg(2n, 'u_self', '合成后续消息', 1020));
      else if (change === 'conversation') await svc.setConversationOverride('c2c', 'u_peer', false);
      else await svc.setConfig({ suggestionsEnabled: false });
      finish(response);
      expect(await pending).toEqual(change === 'message' ? [{ text: '迟到候选' }] : []);
      expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    },
  );

  it('自己发送时的两个开关默认开启且独立保存', async () => {
    const msgs = [textMsg(1n, 'u_self', '自己发出的合成消息', 1000)];
    const analyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'neutral' as const,
      intensity: 20,
      sentiment: 0,
      confidence: 0.8,
    }));
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(analyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local', suggestionsEnabled: true });
    expect(svc.getStatus()).toMatchObject({ analyzeAfterSelf: true, suggestAfterSelf: true });
    await svc.setConfig({ analyzeAfterSelf: false, suggestAfterSelf: true });
    expect((await svc.ensureAnalysis('c2c', 'u_peer')).analyzed).toBe(0);
    expect(await svc.analyzeMessage('c2c', 'u_peer', '1')).toBeNull();
    expect(analyze).not.toHaveBeenCalled();
    expect((await svc.getSuggestions('c2c', 'u_peer')).length).toBeGreaterThan(0);
    const reopened = new IntentSenseService(makeSession(msgs), dir);
    expect(reopened.getStatus()).toMatchObject({ analyzeAfterSelf: false, suggestAfterSelf: true });
    await svc.setConfig({ analyzeAfterSelf: true });
    expect(svc.getStatus().suggestAfterSelf).toBe(true);
    expect((await svc.ensureAnalysis('c2c', 'u_peer')).analyzed).toBe(1);
  });

  it('自己发送后不返回上一轮推荐、不发新推荐请求；下次对方发言才重新生成', async () => {
    const msgs = [textMsg(1n, 'u_peer', '合成对方消息', 1000)];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"replies":[{"text":"合成推荐"}]}' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({
        baseUrl: 'http://fixture',
        apiKey: 'fixture',
        model: ref.model,
      }),
    });
    await svc.setConfig({
      enabled: true,
      providerRef: { providerId: 'fixture', model: 'fixture' },
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
      suggestAfterSelf: false,
    });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toHaveLength(1);
    msgs.push(textMsg(2n, 'u_self', '合成自己回复', 1020));
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    msgs.push(textMsg(3n, 'u_peer', '合成新问题', 1040));
    expect(await svc.getSuggestions('c2c', 'u_peer')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['u_peer', 'u_self'])(
    '推荐请求期间收到 %s 新消息不丢弃在途结果，历史保留本轮实际输入',
    async (sender) => {
      const msgs = [textMsg(1n, 'u_peer', '合成对方消息', 1000)];
      const response = {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"replies":[{"text":"迟到候选"}]}' } }],
        }),
      };
      let finish!: (value: typeof response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const svc = new IntentSenseService(makeSession(msgs), dir, {
        resolveEndpoint: (ref) => ({
          baseUrl: 'http://fixture',
          apiKey: 'fixture',
          model: ref.model,
        }),
      });
      await svc.setConfig({
        enabled: true,
        providerRef: { providerId: 'fixture', model: 'fixture' },
        suggestionsEnabled: true,
        suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
        suggestAfterSelf: false,
      });
      const pending = svc.getSuggestions('c2c', 'u_peer');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      msgs.push(textMsg(2n, sender, '合成后续消息', 1020));
      expect(svc.getSuggestions('c2c', 'u_peer')).toBe(pending);
      finish(response);
      expect(await pending).toEqual([{ text: '迟到候选' }]);
      expect(svc.getSuggestionHistory('c2c', 'u_peer')[0]?.target.msgId).toBe('1');
      if (sender === 'u_self') expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([true, false])(
    '网络遵守取消=%s 时停止推荐均不写历史、不进入冷却，后续消息照常生成',
    async (honorAbort) => {
      const msgs = [textMsg(1n, 'u_peer', '第一条', 1000)];
      let signal: AbortSignal | undefined;
      let finish!: (response: Response) => void;
      const fetchMock = vi.fn((_url: unknown, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((resolve, reject) => {
          finish = resolve;
          if (honorAbort)
            signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
        });
      });
      vi.stubGlobal('fetch', fetchMock);
      const svc = new IntentSenseService(makeSession(msgs), dir, {
        resolveEndpoint: (ref) => ({
          baseUrl: 'http://fixture',
          apiKey: 'fixture',
          model: ref.model,
        }),
      });
      await svc.setConfig({
        suggestionsEnabled: true,
        suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
      });
      const pending = svc.getSuggestions('c2c', 'u_peer');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      msgs.push(textMsg(2n, 'u_peer', '第二条', 1020));
      expect(svc.getSuggestions('c2c', 'u_peer', { refresh: true })).toBe(pending);
      expect(svc.stopSuggestions('group', 'other')).toBe(false);
      expect(svc.stopSuggestions('c2c', 'u_peer')).toBe(true);
      expect(signal?.aborted).toBe(true);
      if (!honorAbort)
        finish(
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"replies":[{"text":"已停止的迟到结果"}]}' } }],
            }),
          ),
        );
      expect(await pending).toEqual([]);
      expect(svc.getSuggestionHistory('c2c', 'u_peer')).toEqual([]);
      expect(svc.getStatus().lastSuggestionApiError).toBeNull();
      fetchMock.mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"replies":[{"text":"新消息推荐"}]}' } }],
            }),
          ),
      );
      expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([{ text: '新消息推荐' }]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it('自己的分析结果保留 mine，批次统计不把它计为新的对方分析', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'neutral' as const,
      intensity: 20,
      sentiment: 0,
      confidence: 0.8,
    }));
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_self', '自己的合成正文', 1000)]),
      dir,
      { localEngine: makeLocalPort(analyze) },
    );
    await svc.setConfig({ enabled: true, engine: 'local' });
    const stats = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(stats.analyzed).toBe(1);
    expect(stats.peerAnalyzed).toBe(0);
    expect(svc.getMessageAnalyses('c2c', 'u_peer', ['1'])[0]?.mine).toBe(true);
  });

  it.each([undefined, {}])('新账号及缺项旧配置采用推荐默认值：%j', (config) => {
    if (config) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    const status = new IntentSenseService(makeSession([]), dir).getStatus();
    expect(DEFAULT_SUGGESTION_CONTEXT_MESSAGES).toBe(30);
    expect(status).toMatchObject({
      suggestAfterSelf: true,
      suggestionContextMessages: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
    });
  });

  it.each([0, 6, 30])('已有推荐关闭及自定义上文 %i 条保持不变', (count) => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ suggestAfterSelf: false, suggestionContextMessages: count }),
    );
    expect(new IntentSenseService(makeSession([]), dir).getStatus()).toMatchObject({
      suggestAfterSelf: false,
      suggestionContextMessages: count,
    });
  });

  it('旧配置回落默认范围，无效条数不部分写入，零值可持久化', async () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true, engine: 'local' }));
    const svc = new IntentSenseService(makeSession([]), dir);
    const defaults = {
      analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
      suggestionContextMessages: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
    };
    expect(svc.getStatus()).toMatchObject(defaults);
    for (const count of [-1, 1.5, MAX_INTENT_CONTEXT_MESSAGES + 1, Number.NaN, Infinity]) {
      await expect(
        svc.setConfig({ analysisContextMessages: 0, suggestionContextMessages: count }),
      ).rejects.toThrow('上文条数');
      expect(svc.getStatus()).toMatchObject(defaults);
    }
    await svc.setConfig({ analysisContextMessages: 0, suggestionContextMessages: 0 });
    expect(new IntentSenseService(makeSession([]), dir).getStatus()).toMatchObject({
      analysisContextMessages: 0,
      suggestionContextMessages: 0,
    });
  });

  it('缺少上文条数元数据的旧缓存必须重算，不硬编码缓存版本', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'neutral' as const,
      intensity: 20,
      sentiment: 0,
      confidence: 0.8,
    }));
    const session = makeSession([textMsg(1n, 'u_peer', '合成正文', 1000)]),
      opts = { localEngine: makeLocalPort(analyze) };
    const svc = new IntentSenseService(session, dir, opts);
    await svc.setConfig({ enabled: true, engine: 'local' });
    await svc.analyzeMessage('c2c', 'u_peer', '1');
    const file = join(dir, 'analysis/c2c_u_peer.json'),
      raw = JSON.parse(readFileSync(file, 'utf8'));
    delete raw.contextMessages;
    writeFileSync(file, JSON.stringify(raw));
    await new IntentSenseService(session, dir, opts).analyzeMessage('c2c', 'u_peer', '1');
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('批量窗口另取边界上文，但不把额外历史算成待分析目标', async () => {
    const msgs = Array.from({ length: 4 }, (_, i) =>
      textMsg(BigInt(i + 1), 'u_peer', `消息${i + 1}`, 1000 + i * 20),
    );
    const analyze = vi.fn(
      async (_text: string, _options?: Parameters<IntentLocalEnginePort['analyze']>[1]) => ({
        intent: 'chat' as const,
        emotion: 'neutral' as const,
        intensity: 20,
        sentiment: 0,
        confidence: 0.8,
      }),
    );
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(analyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local', analysisContextMessages: 2 });
    expect((await svc.ensureAnalysis('c2c', 'u_peer', 1)).analyzed).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[1]?.context?.map((row) => row.text)).toEqual(['消息2', '消息3']);
    expect(svc.listMessageAnalyses('c2c', 'u_peer').map((row) => row.msgId)).toEqual(['4']);
  });

  it('API 批次逐条传入已截取的上文，零条配置不共享整批历史', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) =>
      textMsg(BigInt(i + 1), 'u_peer', `消息${i + 1}`, 1000 + i * 20),
    );
    type Input = { messages: Array<{ i: number; text: string; context: Array<{ text: string }> }> };
    const requests: Input[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const payload = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        const input = JSON.parse(payload.messages[1]!.content) as Input;
        requests.push(input);
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: input.messages.map((row) => ({
                      i: row.i,
                      intent: 'chat',
                      emotion: 'neutral',
                      intensity: 20,
                      sentiment: 0,
                      confidence: 0.8,
                    })),
                  }),
                },
              },
            ],
          }),
        };
      }),
    );
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({
        baseUrl: 'http://fixture',
        apiKey: 'fixture',
        model: ref.model,
      }),
    });
    await svc.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'fixture', model: 'fixture' },
      analysisContextMessages: 2,
    });
    expect((await svc.ensureAnalysis('c2c', 'u_peer', 2)).analyzed).toBe(2);
    expect(requests[0]?.messages.map((row) => row.context.map((turn) => turn.text))).toEqual([
      ['消息3', '消息4'],
      ['消息4', '消息5'],
    ]);
    await svc.setConfig({ analysisContextMessages: 0 });
    expect((await svc.ensureAnalysis('c2c', 'u_peer', 2)).analyzed).toBe(2);
    expect(requests[1]?.messages.map((row) => row.context)).toEqual([[], []]);
  });

  it.each(['count', 'clear'] as const)(
    '重置后新批次不复用旧在途任务，旧任务不删除或污染新任务：%s',
    async (change) => {
      type Result = Awaited<ReturnType<IntentLocalEnginePort['analyze']>>;
      let finishOld!: (value: Result) => void, finishNew!: (value: Result) => void;
      const analyze = vi
        .fn<IntentLocalEnginePort['analyze']>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOld = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishNew = resolve;
            }),
        );
      const svc = new IntentSenseService(
        makeSession([textMsg(1n, 'u_peer', '合成正文', 1000)]),
        dir,
        { localEngine: makeLocalPort(analyze) },
      );
      const event = vi.fn();
      svc.onAnalyzed(event);
      await svc.setConfig({ enabled: true, engine: 'local', analysisContextMessages: 1 });
      const old = svc.ensureAnalysis('c2c', 'u_peer');
      await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
      if (change === 'count') await svc.setConfig({ analysisContextMessages: 0 });
      else svc.clearCache();
      const next = svc.ensureAnalysis('c2c', 'u_peer');
      await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
      const result = {
        intent: 'chat' as const,
        emotion: 'neutral' as const,
        intensity: 20,
        sentiment: 0,
        confidence: 0.8,
      };
      finishOld(result);
      expect((await old).skipped).toBe('config-changed');
      expect(svc.ensureAnalysis('c2c', 'u_peer')).toBe(next);
      expect(svc.listMessageAnalyses('c2c', 'u_peer')).toEqual([]);
      finishNew(result);
      expect((await next).analyzed).toBe(1);
      expect(event).toHaveBeenCalledTimes(1);
      expect(svc.listMessageAnalyses('c2c', 'u_peer')).toHaveLength(1);
    },
  );

  it('旧单条分析与旧推荐回复迟到时不写回新配置，也不返回旧结果', async () => {
    type Result = Awaited<ReturnType<IntentLocalEnginePort['analyze']>>;
    let finishAnalysis!: (value: Result) => void;
    const analyze = vi.fn<IntentLocalEnginePort['analyze']>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAnalysis = resolve;
        }),
    );
    const svc = new IntentSenseService(
      makeSession([textMsg(1n, 'u_peer', '合成正文', 1000)]),
      dir,
      {
        localEngine: makeLocalPort(analyze),
        resolveEndpoint: (ref) => ({
          baseUrl: 'http://fixture',
          apiKey: 'fixture',
          model: ref.model,
        }),
      },
    );
    await svc.setConfig({ enabled: true, engine: 'local', analysisContextMessages: 1 });
    const oldAnalysis = svc.analyzeMessage('c2c', 'u_peer', '1');
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    await svc.setConfig({ analysisContextMessages: 0 });
    finishAnalysis({
      intent: 'chat',
      emotion: 'neutral',
      intensity: 20,
      sentiment: 0,
      confidence: 0.8,
    });
    expect(await oldAnalysis).toBeNull();
    expect(svc.listMessageAnalyses('c2c', 'u_peer')).toEqual([]);
    const response = (text: string) => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ replies: [{ text }] }) } }],
      }),
    });
    let finishReply!: (value: ReturnType<typeof response>) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishReply = resolve;
          }),
      )
      .mockResolvedValue(response('新建议'));
    vi.stubGlobal('fetch', fetchMock);
    await svc.setConfig({
      engine: 'api',
      providerRef: { providerId: 'fixture', model: 'fixture' },
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'fixture', model: 'fixture' },
      suggestionContextMessages: 1,
    });
    const oldReply = svc.getSuggestions('c2c', 'u_peer');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await svc.setConfig({ suggestionContextMessages: 0 });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([
      { text: '新建议', tone: undefined },
    ]);
    finishReply(response('旧建议'));
    expect(await oldReply).toEqual([]);
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([
      { text: '新建议', tone: undefined },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, {}, { featureSettingsVersion: 2 }])(
    '新配置或缺少开关字段时，意图感知与推荐回复默认关闭：%j',
    async (config) => {
      if (config !== undefined) {
        writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
      }
      const session = makeSession([textMsg(1n, 'u_peer', '合成消息', 1000)]);
      const analyze = vi.fn(async () => null);
      const svc = new IntentSenseService(session, dir, {
        localEngine: makeLocalPort(analyze),
      });
      expect(svc.getStatus()).toMatchObject({ enabled: false, suggestionsEnabled: false });
      await svc.setConversationOverride('c2c', 'u_peer', true);
      expect(svc.effectiveFor('c2c', 'u_peer')).toBe(false);
      expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
      expect(session.c2cMsgs.listLatest).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: true, suggestionsEnabled: false },
    { enabled: false, suggestionsEnabled: true },
    { enabled: true, suggestionsEnabled: true },
  ])('保留已保存的独立开关选择：%j', async (config) => {
    const svc = new IntentSenseService(makeSession([]), dir);
    await svc.setConfig(config);
    expect(new IntentSenseService(makeSession([]), dir).getStatus()).toMatchObject(config);
  });

  it('配置默认关闭；会话覆盖 false 强制关、清除后跟随全局', async () => {
    const svc = new IntentSenseService(makeSession([]), dir, {
      localEngine: makeLocalPort(async () => null),
    });
    expect(svc.getStatus().enabled).toBe(false);
    expect(svc.effectiveFor('c2c', 'u_peer')).toBe(false);

    await svc.setConfig({ enabled: true, engine: 'local' });
    expect(svc.effectiveFor('c2c', 'u_peer')).toBe(true);

    await svc.setConversationOverride('c2c', 'u_peer', false);
    expect(svc.effectiveFor('c2c', 'u_peer')).toBe(false);

    await svc.setConversationOverride('c2c', 'u_peer', null);
    expect(svc.effectiveFor('c2c', 'u_peer')).toBe(true);
  });

  it('api 引擎未配置 provider 时对任意会话都不生效', async () => {
    const svc = new IntentSenseService(makeSession([]), dir, {
      resolveEndpoint: (ref) => {
        if ('useDefault' in ref) throw new Error('未设置默认模型');
        return { baseUrl: 'http://x', apiKey: 'k', model: ref.model };
      },
    });
    await svc.setConfig({ enabled: true, engine: 'api' });
    expect(svc.effectiveFor('c2c', 'u_peer')).toBe(false);
    await svc.setConfig({ providerRef: { providerId: 'p', model: 'm' } });
    expect(svc.effectiveFor('c2c', 'u_peer')).toBe(true);
  });

  it('ensureAnalysis 增量：首轮全分析，次轮命中缓存零引擎调用', async () => {
    const analyze = vi.fn(async (_text: string) => ({
      intent: 'chat' as const,
      emotion: 'joy' as const,
      intensity: 60,
      sentiment: 40,
      confidence: 0.9,
    }));
    const msgs = [
      textMsg(1n, 'u_peer', '在吗', 1000),
      textMsg(2n, 'u_self', '咋了', 2000),
      textMsg(3n, 'u_peer', '没事啦', 3000),
    ];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(analyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local' });

    const first = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(first.analyzed).toBe(3);
    expect(analyze).toHaveBeenCalledTimes(3);
    // mine 标记：c2c 里非对方即自己。
    const got = svc.getMessageAnalyses('c2c', 'u_peer', ['1', '2', '3']);
    expect(got.find((r) => r.msgId === '2')?.mine).toBe(true);
    expect(got.find((r) => r.msgId === '1')?.mine).toBe(false);

    const second = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(second.analyzed).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it('新消息只补缺口（增量语义）', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'neutral' as const,
      intensity: 50,
      sentiment: 0,
      confidence: 0.5,
    }));
    const session = makeSession([textMsg(1n, 'u_peer', '早', 1000)]);
    const svc = new IntentSenseService(session, dir, {
      localEngine: makeLocalPort(analyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local' });
    await svc.ensureAnalysis('c2c', 'u_peer');

    // 来了一条新消息：换桩返回两条。
    (session.c2cMsgs.listLatest as ReturnType<typeof vi.fn>).mockResolvedValue([
      textMsg(2n, 'u_peer', '晚', 2000),
      textMsg(1n, 'u_peer', '早', 1000),
    ]);
    const next = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(next.analyzed).toBe(1);
    expect(next.cached).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('api 批处理：解析结构化回复并钳制非法值', async () => {
    const msgs = [
      textMsg(1n, 'u_peer', '明天出来玩吗', 1000),
      textMsg(2n, 'u_self', '看情况', 2000),
    ];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({ baseUrl: 'http://x', apiKey: 'k', model: ref.model }),
    });
    await svc.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'p', model: 'm' },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '前言\n```json\n{"results":[{"i":0,"intent":"plan","emotion":"excitement","intensity":999,"sentiment":-500,"confidence":2},{"i":1,"intent":"乱写的","emotion":"不存在","intensity":10,"sentiment":5,"confidence":0.4},{"i":99,"intent":"plan","emotion":"joy","intensity":1,"sentiment":1,"confidence":1}]}\n```',
            },
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const stats = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(stats.analyzed).toBe(2);
    const got = svc.getMessageAnalyses('c2c', 'u_peer', ['1', '2']);
    const first = got.find((r) => r.msgId === '1');
    expect(first?.intent).toBe('plan');
    expect(first?.intensity).toBe(100); // 999 → 钳到 100
    expect(first?.sentiment).toBe(-100); // -500 → 钳到 -100
    expect(first?.engine).toBe('api');
    const second = got.find((r) => r.msgId === '2');
    expect(second?.intent).toBe('other'); // 未知枚举 → other
    expect(second?.emotion).toBe('neutral'); // 未知枚举 → neutral
    // 序号越界（i:99）的那条被丢弃。
    expect(got.length).toBe(2);
  });

  it('analyzeMessage 命中缓存直接返回，未命中走引擎', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'question' as const,
      emotion: 'curiosity' as const,
      intensity: 55,
      sentiment: 10,
      confidence: 0.8,
    }));
    const svc = new IntentSenseService(makeSession([textMsg(7n, 'u_peer', '几点了', 5000)]), dir, {
      localEngine: makeLocalPort(analyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local' });

    const r1 = await svc.analyzeMessage('c2c', 'u_peer', '7');
    expect(r1?.intent).toBe('question');
    const r2 = await svc.analyzeMessage('c2c', 'u_peer', '7');
    expect(r2?.msgId).toBe('7');
    expect(analyze).toHaveBeenCalledTimes(1);
    await svc.analyzeMessage('c2c', 'u_peer', '7', { manual: true });
    expect(analyze).toHaveBeenCalledTimes(2);
    await svc.analyzeMessage('c2c', 'u_peer', '7');
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('语境与语料库校准：上文展示牛逼成果时，下文「吓哭了/给跪了/卧槽」判为夸赞(praise)+赞叹(admiration)', async () => {
    // 模拟字面分类器被「吓」「哭」「卧槽」误导，原始返回 anxiety/sadness/anger 与负向情感分
    const literalBlindAnalyze = vi.fn(async (text: string, opts?: unknown) => {
      expect(opts).toBeDefined();
      if (text.includes('做出')) {
        return {
          intent: 'share' as const,
          emotion: 'excitement' as const,
          intensity: 80,
          sentiment: 70,
          confidence: 0.8,
        };
      }
      return {
        intent: 'vent' as const,
        emotion: 'anxiety' as const,
        intensity: 60,
        sentiment: -70,
        confidence: 0.55,
      };
    });

    const msgs = [
      textMsg(1n, 'u_self', '我刚把整个引擎手搓重构完了，做出了一个很牛逼的成果！', 1000),
      textMsg(2n, 'u_peer', '吓哭了', 1020),
      textMsg(3n, 'u_peer', '给大佬跪了', 1030),
      textMsg(4n, 'u_peer', '卧槽', 1040),
    ];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(literalBlindAnalyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local' });

    await svc.ensureAnalysis('c2c', 'u_peer');
    const got = svc.getMessageAnalyses('c2c', 'u_peer', ['2', '3', '4']);
    for (const id of ['2', '3', '4']) {
      const item = got.find((r) => r.msgId === id);
      expect(item?.intent).toBe('praise');
      expect(item?.emotion).toBe('admiration');
      expect(item?.sentiment).toBeGreaterThanOrEqual(80);
      expect(item?.intensity).toBeGreaterThanOrEqual(80);
    }
  });

  it('真实惊吓语境消歧：上文提到半夜遇到蛇，下文「吓哭了」保持焦虑(anxiety)而非赞叹', async () => {
    const analyze = vi.fn(async () => ({
      intent: 'vent' as const,
      emotion: 'anxiety' as const,
      intensity: 85,
      sentiment: -75,
      confidence: 0.85,
    }));
    const msgs = [
      textMsg(1n, 'u_self', '昨晚走夜路看到一条大蛇差点踩上去，太吓人了', 1000),
      textMsg(2n, 'u_peer', '吓哭了', 1020),
    ];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(analyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local' });

    await svc.ensureAnalysis('c2c', 'u_peer');
    const [res] = svc.getMessageAnalyses('c2c', 'u_peer', ['2']);
    expect(res?.emotion).toBe('anxiety');
    expect(res?.sentiment).toBeLessThan(0);
  });

  it('中文互联网黑话与反语校准：笑死 / 羡慕哭了 / 泪目 / 啊对对对 / 人麻了', async () => {
    // 模拟字面模型把带「死/哭/麻」全判成 sadness，把「对对对」判成 joy
    const naiveAnalyze = vi.fn(async (text: string) => {
      if (text.includes('对对对')) {
        return {
          intent: 'chat' as const,
          emotion: 'joy' as const,
          intensity: 40,
          sentiment: 60,
          confidence: 0.5,
        };
      }
      return {
        intent: 'vent' as const,
        emotion: 'sadness' as const,
        intensity: 50,
        sentiment: -60,
        confidence: 0.5,
      };
    });
    const msgs = [
      textMsg(1n, 'u_peer', '笑死我了蚌埠住了', 1000),
      textMsg(2n, 'u_peer', '羡慕哭了', 1100),
      textMsg(3n, 'u_peer', '感动哭了泪目', 1200),
      textMsg(4n, 'u_peer', '啊对对对', 1300),
      textMsg(5n, 'u_peer', '加班到现在人麻了', 1400),
    ];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(naiveAnalyze),
    });
    await svc.setConfig({ enabled: true, engine: 'local' });

    await svc.ensureAnalysis('c2c', 'u_peer');
    const byId = new Map(
      svc.getMessageAnalyses('c2c', 'u_peer', ['1', '2', '3', '4', '5']).map((r) => [r.msgId, r]),
    );

    expect(byId.get('1')?.intent).toBe('joke');
    expect(byId.get('1')?.emotion).toBe('joy');
    expect(byId.get('1')?.sentiment).toBeGreaterThan(0);

    expect(byId.get('2')?.intent).toBe('praise');
    expect(byId.get('2')?.emotion).toBe('admiration');
    expect(byId.get('2')?.sentiment).toBeGreaterThan(0);

    expect(byId.get('3')?.emotion).toBe('affection');
    expect(byId.get('3')?.sentiment).toBeGreaterThan(0);

    expect(byId.get('4')?.intent).toBe('perfunctory');
    expect(byId.get('4')?.emotion).toBe('irony');
    expect(byId.get('4')?.sentiment).toBeLessThan(0);

    expect(byId.get('5')?.intent).toBe('vent');
    expect(byId.get('5')?.emotion).toBe('fatigue');
    expect(byId.get('5')?.sentiment).toBeLessThan(0);
  });

  it('analyzeMessage 单条悬停支持 API 引擎并自动携带前序上下文', async () => {
    const msgs = [
      textMsg(1n, 'u_self', '这个算法我优化了100倍，终于做出来了！', 1000),
      textMsg(2n, 'u_peer', '吓哭了', 1015),
    ];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({ baseUrl: 'http://x', apiKey: 'k', model: ref.model }),
    });
    await svc.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'p', model: 'm' },
    });
    const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
      const payload = JSON.parse(init?.body ?? '{}') as {
        messages?: Array<{ role: string; content: string }>;
      };
      const userPrompt = payload.messages?.find((m) => m.role === 'user')?.content ?? '';
      // 验证单条悬停请求里包含了上文参考
      expect(userPrompt).toContain('优化了100倍');
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  '{"results":[{"i":0,"intent":"vent","emotion":"anxiety","intensity":70,"sentiment":-50,"confidence":0.6}]}',
              },
            },
          ],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await svc.analyzeMessage('c2c', 'u_peer', '2');
    expect(res?.intent).toBe('praise');
    expect(res?.emotion).toBe('admiration');
    expect(res?.sentiment).toBeGreaterThanOrEqual(80);
  });

  it('detectUpstreamSignal 严格遵守时效性推断窗口（时隔超过10分钟不计入因果上下文）', () => {
    // 1. 紧邻发生（1分钟内）：判定为 achievement 上文
    const freshContext = [
      { mine: false, text: '我这自研核心算法重构完跑通了，性能提升100倍！', sendTime: 1000 },
    ];
    const freshSignal = detectUpstreamSignal(freshContext, 1060);
    expect(freshSignal).toBe('achievement');
    const freshPrag = analyzePragmatics('吓哭了', freshContext, 1060);
    expect(freshPrag.override?.intent).toBe('praise');
    expect(freshPrag.override?.emotion).toBe('admiration');

    // 2. 时隔过长（例如 2 小时后才发「吓哭了」）：时效已过，不得关联上文成果
    const staleContext = [
      { mine: false, text: '我这自研核心算法重构完跑通了，性能提升100倍！', sendTime: 1000 },
    ];
    const staleSignal = detectUpstreamSignal(staleContext, 1000 + 7200);
    expect(staleSignal).toBe('neutral');
    const stalePrag = analyzePragmatics('吓哭了', staleContext, 1000 + 7200);
    expect(stalePrag.upstreamSignal).toBe('neutral');
    expect(stalePrag.override).toBeNull();
  });

  it('细分意图与情感语料识别：炫耀 / 吹捧 / 调侃 / 撒娇 / 吃瓜 / 委屈', () => {
    // 炫耀
    const boast = analyzePragmatics('终于抽到满命专武了，看看我的神级面板！');
    expect(boast.override?.intent).toBe('boast');
    expect(boast.override?.emotion).toBe('excitement');

    // 吹捧
    const flattery = analyzePragmatics('大佬受我一拜，代码写得太权威了，仙品细糠！');
    expect(flattery.override?.intent).toBe('flattery');
    expect(flattery.override?.emotion).toBe('admiration');

    // 调侃
    const banter = analyzePragmatics('就这啊？你小子差不多得了，夺笋啊');
    expect(banter.override?.intent).toBe('banter');
    expect(banter.override?.emotion).toBe('joy');

    // 吃瓜
    const gossip = analyzePragmatics('尊嘟假嘟？快求细说，蹲一个后续');
    expect(gossip.override?.intent).toBe('gossip');
    expect(gossip.override?.emotion).toBe('curiosity');

    // 撒娇
    const coquetry = analyzePragmatics('好哥哥带带我嘛呜呜呜，求求你了');
    expect(coquetry.override?.intent).toBe('coquetry');
    expect(coquetry.override?.emotion).toBe('affection');

    // 委屈
    const aggrieved = analyzePragmatics('太欺负人了，好委屈，凭什么啊');
    expect(aggrieved.override?.intent).toBe('vent');
    expect(aggrieved.override?.emotion).toBe('aggrieved');

    // 否定句与疑问句不应误触发炫耀（boast）
    expect(analyzePragmatics('还没过审').override).toBeNull();
    expect(analyzePragmatics('什么时候提车？').override).toBeNull();
  });

  it('API 故障熔断与本地引擎降级：多批次请求首轮失败后立即熔断或降级本地引擎，不刷屏重试', async () => {
    // 构造 45 条消息（超过 API_BATCH=20，分 3 批）
    const msgs = Array.from({ length: 45 }, (_, i) =>
      textMsg(BigInt(i + 1), 'u_peer', `测试消息 ${i + 1}`, 1000 + i * 10),
    );
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    // 1. 无本地引擎时：第 1 批失败即熔断中止，fetch 只调用 1 次而非 3 次
    const svcNoLocal = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({
        baseUrl: 'http://dead-endpoint',
        apiKey: 'k',
        model: ref.model,
      }),
    });
    await svcNoLocal.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'p', model: 'm' },
    });
    const statsNoLocal = await svcNoLocal.ensureAnalysis('c2c', 'u_peer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statsNoLocal.analyzed).toBe(0);
    expect(statsNoLocal.failed).toBe(45);

    // 2. 有本地引擎就绪时：API 失败后自动降级到本地引擎完成全部分析，且传递 gap_sec
    fetchMock.mockClear();
    let capturedGapSec: number | undefined;
    const localAnalyze = vi.fn(
      async (_text: string, opts?: { context?: Array<{ gap_sec?: number }> }) => {
        if (opts?.context && opts.context.length > 0 && capturedGapSec === undefined) {
          capturedGapSec = opts.context[opts.context.length - 1]?.gap_sec;
        }
        return {
          intent: 'chat' as const,
          emotion: 'joy' as const,
          intensity: 60,
          sentiment: 30,
          confidence: 0.85,
        };
      },
    );
    const svcWithLocal = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({
        baseUrl: 'http://dead-endpoint',
        apiKey: 'k',
        model: ref.model,
      }),
      localEngine: makeLocalPort(localAnalyze),
    });
    await svcWithLocal.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'p', model: 'm' },
    });
    const statsWithLocal = await svcWithLocal.ensureAnalysis('c2c', 'u_peer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statsWithLocal.analyzed).toBe(45);
    expect(capturedGapSec).toBe(10);
  });

  it('getSuggestions 支持本地引擎及 API 失败兜底生成候选回复', async () => {
    const msgs = [textMsg(1n, 'u_peer', '尊嘟假嘟？快展开讲讲！', 1000)];
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      localEngine: makeLocalPort(async () => ({
        intent: 'gossip',
        emotion: 'curiosity',
        intensity: 75,
        sentiment: 30,
        confidence: 0.9,
      })),
    });
    await svc.setConfig({ enabled: true, engine: 'local', suggestionsEnabled: true });
    await svc.ensureAnalysis('c2c', 'u_peer');

    const suggestions = await svc.getSuggestions('c2c', 'u_peer');
    expect(suggestions.length).toBe(3);
    expect(suggestions[0]?.text.length).toBeGreaterThan(0);
  });

  it('切换到 API 或 API 恢复后，自动将旧 local 降级缓存重刷为 api 结果，且支持 clearCache 清空缓存', async () => {
    const msgs = [textMsg(1n, 'u_peer', '今天去哪吃', 1000)];
    const localAnalyze = vi.fn(async () => ({
      intent: 'chat' as const,
      emotion: 'neutral' as const,
      intensity: 40,
      sentiment: 0,
      confidence: 0.6,
    }));
    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({ baseUrl: 'http://ok-endpoint', apiKey: 'k', model: ref.model }),
      localEngine: makeLocalPort(localAnalyze),
    });

    // 先用 local 跑一遍，落入缓存（engine: 'local'）
    await svc.setConfig({ enabled: true, engine: 'local' });
    await svc.ensureAnalysis('c2c', 'u_peer');
    expect(svc.getMessageAnalyses('c2c', 'u_peer', ['1'])[0]?.engine).toBe('local');

    // 切换到 api 引擎：旧 local 缓存不应阻挡 API 重算
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                '{"results":[{"i":0,"intent":"question","emotion":"curiosity","intensity":65,"sentiment":15,"confidence":0.92}]}',
            },
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    await svc.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'p', model: 'm' },
    });

    const upgraded = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(upgraded.analyzed).toBe(1);
    const afterApi = svc.getMessageAnalyses('c2c', 'u_peer', ['1'])[0];
    expect(afterApi?.engine).toBe('api');
    expect(afterApi?.intent).toBe('question');

    // clearCache 清空内存与磁盘缓存
    const cleared = await svc.clearCache();
    expect(cleared.clearedFiles).toBe(1);
    expect(svc.getMessageAnalyses('c2c', 'u_peer', ['1']).length).toBe(0);
  });

  it('getSuggestions 在途请求并发去重，防止重复触发 API 调用', async () => {
    const msgs = [textMsg(1n, 'u_peer', '明天下午一起去打羽毛球吗？', 1000)];
    const fetchMock = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"replies":[{"text":"好啊，几点去？"}]}' } }],
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({ baseUrl: 'http://api', apiKey: 'k', model: ref.model }),
    });
    await svc.setConfig({
      enabled: true,
      suggestionsEnabled: true,
      suggestionProviderRef: { providerId: 'p', model: 'm' },
    });

    const [res1, res2] = await Promise.all([
      svc.getSuggestions('c2c', 'u_peer'),
      svc.getSuggestions('c2c', 'u_peer'),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res1).toEqual([{ text: '好啊，几点去？' }]);
    expect(res2).toEqual([{ text: '好啊，几点去？' }]);
  });

  it('api 引擎下命中 hard 规则或日常应答时直接本地短路，免调 API', async () => {
    const msgs = [
      textMsg(1n, 'u_peer', '好的收到', 1000),
      textMsg(2n, 'u_peer', '啊对对对', 2000),
      textMsg(3n, 'u_peer', '[动画表情]', 3000),
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const svc = new IntentSenseService(makeSession(msgs), dir, {
      resolveEndpoint: (ref) => ({ baseUrl: 'http://api', apiKey: 'k', model: ref.model }),
    });
    await svc.setConfig({
      enabled: true,
      engine: 'api',
      providerRef: { providerId: 'p', model: 'm' },
    });

    const stats = await svc.ensureAnalysis('c2c', 'u_peer');
    expect(stats.analyzed).toBe(3);
    // 全部命中硬规则短路，API 一次都没被调用
    expect(fetchMock).not.toHaveBeenCalled();

    const analyses = svc.getMessageAnalyses('c2c', 'u_peer', ['1', '2', '3']);
    expect(analyses[0]).toMatchObject({
      msgId: '1',
      intent: 'chat',
      emotion: 'neutral',
      engine: 'api',
    });
    expect(analyses[1]).toMatchObject({
      msgId: '2',
      intent: 'perfunctory',
      emotion: 'irony',
      engine: 'api',
    });
    expect(analyses[2]).toMatchObject({
      msgId: '3',
      intent: 'chat',
      emotion: 'neutral',
      engine: 'api',
    });

    // 单条分析 analyzeMessage 也短路
    const single = await svc.analyzeMessage('c2c', 'u_peer', '1');
    expect(single).toMatchObject({ msgId: '1', intent: 'chat', engine: 'api' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
