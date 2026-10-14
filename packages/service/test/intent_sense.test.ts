/**
 * IntentSenseService 单测：钉住三个核心约定 ——
 *   1. 配置归一化与会话覆盖语义（effectiveFor）；
 *   2. ensureAnalysis 增量语义（缓存命中的消息绝不重跑引擎，只补缺口）；
 *   3. api 引擎的结构化 JSON 解析防御（围栏/越界枚举/数值钳制/序号越界丢弃）。
 *
 * session 用结构化桩：服务只用 c2cMsgs/groupMsgs/uidMap/context.uin 五个面，
 * 不需要真的 AccountSession。fetch 全局打桩驱动 api 批处理分支。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { IntentSenseService, type IntentLocalEnginePort } from '../src/account/intent_sense';

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
      listLatest: vi.fn(async () => [...msgs].reverse()), // db 语义：新→旧
      listByMsgIds: vi.fn(async (ids: bigint[]) => msgs.filter((m) => ids.includes(m.msgId))),
    },
    groupMsgs: {
      listLatest: vi.fn(async () => [...msgs].reverse()),
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
});
