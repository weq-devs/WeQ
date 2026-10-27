import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { AgentLabStore, AgentRuntime } from '@weq/agentlab';
import { afterEach, expect, it, vi } from 'vitest';
import { BotOrchestrator } from '../../bot/src/orchestrator';
import type { IncomingEvent, OneBot11Adapter } from '../../bot/src/adapter/types';
import {
  JsonConversationStore,
  JsonMemoryStore,
  JsonNotesStore,
  JsonRelationStore,
} from '../../bot/src/stores';
import { BotLogger, BOT_CONTENT_DEBUG_MAX_MS, BOT_CONTENT_LOG_LIMIT } from '../../bot/src/logger';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('运行时上下文按白名单输出，关联标识不包含原始对端且每次启动不同', () => {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => {
    lines.push(String(line));
  });
  const logger = BotLogger.create();
  const peer = '123456789012';
  const ref = logger.ref('private', peer);
  logger.child({ personaId: 'PERSONA_PRIVATE', errorMessage: 'ERROR_PRIVATE' }).info('safe', {
    text: 'BODY_PRIVATE',
    reason: 'REASON_PRIVATE',
    senderId: peer,
    peerRef: ref,
    textLen: 7,
    constructor: 'PRIVATE_CONSTRUCTOR',
  });
  const all = lines.join('\n');
  for (const secret of [
    'PERSONA_PRIVATE',
    'ERROR_PRIVATE',
    'BODY_PRIVATE',
    'REASON_PRIVATE',
    peer,
    'PRIVATE_CONSTRUCTOR',
  ])
    expect(all).not.toContain(secret);
  expect(JSON.parse(lines[0]!)).toMatchObject({ textLen: 7, peerRef: ref });
  expect(logger.child({}).ref('private', peer)).toBe(ref);
  expect(BotLogger.create().ref('private', peer)).not.toBe(ref);
});

it('正文调试需显式短期截止时间，输出单行且可立即关闭，到期/重启不会延长', () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line) => {
    lines.push(String(line));
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const config = { debugContentUntil: new Date(Date.now() + 1000).toISOString() };
  const logger = BotLogger.create(config);
  expect(warn).toHaveBeenCalledOnce();
  logger.content('incoming', 'PRIVATE_DEBUG\nforged-header');
  expect(lines[0]).toContain('PRIVATE_DEBUG');
  expect(lines[0]).not.toContain('\n');
  logger.content('sent', 'x'.repeat(BOT_CONTENT_LOG_LIMIT + 10));
  expect(JSON.parse(lines[1]!).text).toHaveLength(BOT_CONTENT_LOG_LIMIT);
  logger.disableContent();
  logger.content('incoming', 'DISABLED_PRIVATE');
  expect(lines).toHaveLength(2);
  const restarted = BotLogger.create(config);
  vi.setSystemTime(Date.now() + 1001);
  restarted.content('sent', 'EXPIRED_PRIVATE');
  expect(BotLogger.create(config).debugEnabled).toBe(false);
  expect(lines).toHaveLength(2);
  vi.setSystemTime(Date.now() - 2000);
  restarted.content('sent', 'REOPENED_PRIVATE');
  expect(lines).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('无时区或超过最长调试窗口的配置不会静默开启正文日志', () => {
  expect(() => BotLogger.create({ debugContentUntil: '2026-99-99T25:00:00+08:00' })).toThrow();
  expect(() => BotLogger.create({ debugContentUntil: '2026-10-27T18:00:00' })).toThrow();
  expect(() =>
    BotLogger.create({
      debugContentUntil: new Date(Date.now() + BOT_CONTENT_DEBUG_MAX_MS + 1000).toISOString(),
    }),
  ).toThrow();
});

it('系统时钟回拨也不能延长已开启的正文调试窗口', () => {
  vi.useFakeTimers();
  const monotonic = vi.spyOn(performance, 'now').mockReturnValue(100);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const logger = BotLogger.create({ debugContentUntil: new Date(Date.now() + 1000).toISOString() });
  vi.setSystemTime(Date.now() - 60_000);
  monotonic.mockReturnValue(1101);
  expect(logger.debugEnabled).toBe(false);
});

it('默认实际编排日志不包含正文、回复、身份、决策原文或异常中的私聊内容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-log-'));
  roots.push(root);
  const logs: string[] = [];
  const capture = (...args: unknown[]) => {
    logs.push(args.map((v) => (typeof v === 'string' ? v : inspect(v, { depth: 8 }))).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  const runtime = new AgentRuntime({
    rootDir: root,
    store: new AgentLabStore(join(root, 'personas')),
    endpoints: () => {
      throw new Error('不得联网');
    },
    usage: { record: () => {} },
    conversations: new JsonConversationStore(join(root, 'conversations.json')),
    memories: new JsonMemoryStore(join(root, 'memories.json')),
    notes: new JsonNotesStore(join(root, 'notes.json')),
    relations: new JsonRelationStore(join(root, 'relations.json')),
    selfId: 'bot',
  });
  const output = 'OUTPUT_PRIVATE_SENTINEL';
  vi.spyOn(runtime, 'chat').mockImplementation(async ({ text }) => {
    if (text.includes('fail')) throw new Error('ERROR_PRIVATE_SENTINEL ' + text);
    return {
      text: output,
      segments: [output],
      actions: [{ kind: 'text', text: output }],
      promptPreview: '',
      matches: [],
      usedMemoryIds: [],
      willingness: 1,
      replyDelayMs: 0,
      sticker: null,
      renderedTurns: [output],
      silent: false,
    };
  });
  vi.spyOn(runtime, 'handleGroupMessage').mockResolvedValue({
    renderedTurns: [output],
    replyDelayMs: 0,
    silent: false,
    reason: 'REASON_PRIVATE_SENTINEL',
    score: 1,
  });
  let handler: (event: IncomingEvent) => void = () => {};
  const send = vi.fn(async () => ({}));
  const adapter: OneBot11Adapter = {
    type: 'napcat',
    connect: async () => {},
    close: () => {},
    onEvent: (callback) => {
      handler = callback;
    },
    sendMessage: send,
    callAction: async () => ({}),
  };
  const bot = new BotOrchestrator(
    adapter,
    runtime,
    'persona',
    'bot',
    { stickerPath: () => null, voicePath: () => null },
    { groupChat: true },
  );
  bot.start();
  const emit = (text: string, group = false) =>
    handler({
      post_type: 'message',
      message_type: group ? 'group' : 'private',
      user_id: '123456789012',
      group_id: '987654321098',
      sender: { nickname: 'PRIVATE_NICK_SENTINEL' },
      message: text,
    });
  try {
    emit('INBOUND_PRIVATE_SENTINEL');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    emit('INBOUND_PRIVATE_SENTINEL fail');
    await vi.waitFor(() => expect(runtime.chat).toHaveBeenCalledTimes(2));
    emit('INBOUND_PRIVATE_SENTINEL', true);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    send.mockRejectedValueOnce(new Error('ERROR_PRIVATE_SENTINEL echoed packet'));
    emit('INBOUND_PRIVATE_SENTINEL');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  } finally {
    await bot.stop();
    await runtime.close();
  }
  const all = logs.join('\n');
  for (const secret of [
    'INBOUND_PRIVATE_SENTINEL',
    output,
    '123456789012',
    '987654321098',
    'PRIVATE_NICK_SENTINEL',
    'REASON_PRIVATE_SENTINEL',
    'ERROR_PRIVATE_SENTINEL',
  ])
    expect(all).not.toContain(secret);
  expect(all).toContain('生成');
  expect(all).toContain('发送');
  expect(all).toContain('失败');
  expect(send.mock.calls[0]).toEqual([
    { chatType: 'private', peerId: '123456789012' },
    [{ type: 'text', data: { text: output } }],
  ]);
});
