/**
 * IntentSenseService 单测：钉住三个核心约定 ——
 *   1. 配置归一化与会话覆盖语义（effectiveFor）；
 *   2. ensureAnalysis 增量语义（缓存命中的消息绝不重跑引擎，只补缺口）；
 *   3. api 引擎的结构化 JSON 解析防御（围栏/越界枚举/数值钳制/序号越界丢弃）。
 *
 * session 用结构化桩：服务只用 c2cMsgs/groupMsgs/uidMap/context.uin 五个面，
 * 不需要真的 AccountSession。fetch 全局打桩驱动 api 批处理分支。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentSenseService, type IntentLocalEnginePort } from '../src/account/intent_sense';
import { detectUpstreamSignal, analyzePragmatics } from '../src/account/intent_corpus';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import type { AccountSession } from '@weq/account';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
} from '../src/common/intent_context';

interface StubMsg {
  msgId: bigint;
  senderUid: string;
  senderUin: bigint;
  sendTime: bigint;
  elements: Array<{ kind: 'text'; textContent: string } | { kind: 'face'; faceText: string }>;
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
    for (const profileEngine of ['heuristic', 'local', 'api', 'follow'] as const) {
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
    await svc.setConfig({ enabled: true, engine: 'local', profileEngine: 'heuristic' });
    await svc.ensureAnalysis('c2c', 'u_peer');
    expect(await svc.getProfile('u_peer')).toMatchObject({ sampled: 1, analyzedSamples: 1 });
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
    const requests: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      requests.push(body.messages[1]!.content);
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
    expect(requests[0]?.split('\n')).toEqual(['对方: 消息5', '对方: 消息6']);
    await svc.getSuggestions('c2c', 'u_peer');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await svc.setConfig({ suggestionContextMessages: 3 });
    await svc.getSuggestions('c2c', 'u_peer');
    expect(requests[1]?.split('\n')).toEqual([
      '对方: 消息3',
      '对方: 消息4',
      '对方: 消息5',
      '对方: 消息6',
    ]);
    await svc.setConfig({ suggestionContextMessages: 0 });
    await svc.getSuggestions('c2c', 'u_peer');
    expect(requests[2]).toBe('对方: 消息6');
  });

  it('自己发送时的两个开关独立保存，旧配置保持分析开启、推荐关闭', async () => {
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
    expect(svc.getStatus()).toMatchObject({ analyzeAfterSelf: true, suggestAfterSelf: false });
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
    });
    expect(await svc.getSuggestions('c2c', 'u_peer')).toHaveLength(1);
    msgs.push(textMsg(2n, 'u_self', '合成自己回复', 1020));
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    msgs.push(textMsg(3n, 'u_peer', '合成新问题', 1040));
    expect(await svc.getSuggestions('c2c', 'u_peer')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('推荐请求期间自己已发送，迟到候选不再发布或留给旧客户端', async () => {
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
    });
    const pending = svc.getSuggestions('c2c', 'u_peer');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    msgs.push(textMsg(2n, 'u_self', '合成自己回复', 1020));
    finish(response);
    expect(await pending).toEqual([]);
    expect(await svc.getSuggestions('c2c', 'u_peer')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

  it('旧配置回落原有实际范围，无效条数不部分写入，零值可持久化', async () => {
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
      resolveEndpoint: (ref) => ({ baseUrl: 'http://x', apiKey: 'k', model: ref.model }),
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
});
