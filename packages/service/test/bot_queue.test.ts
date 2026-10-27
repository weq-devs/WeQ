import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(text: string): Awaited<ReturnType<AgentRuntime['chat']>> {
  return {
    text,
    segments: [text],
    actions: [{ kind: 'text', text }],
    promptPreview: '',
    matches: [],
    usedMemoryIds: [],
    willingness: 1,
    replyDelayMs: 0,
    sticker: null,
    renderedTurns: [text],
    silent: false,
  };
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(opts: ConstructorParameters<typeof BotOrchestrator>[5] = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-queue-'));
  roots.push(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const runtime = new AgentRuntime({
    rootDir: root,
    store: new AgentLabStore(join(root, 'personas')),
    endpoints: () => {
      throw new Error('测试不得访问模型');
    },
    usage: { record: () => {} },
    conversations: new JsonConversationStore(join(root, 'conversations.json')),
    memories: new JsonMemoryStore(join(root, 'memories.json')),
    notes: new JsonNotesStore(join(root, 'notes.json')),
    relations: new JsonRelationStore(join(root, 'relations.json')),
    selfId: 'bot',
  });
  let handler: (event: IncomingEvent) => void = () => {};
  const adapter: OneBot11Adapter = {
    type: 'napcat',
    connect: async () => {},
    close: () => {},
    onEvent: (callback) => {
      handler = callback;
    },
    sendMessage: vi.fn(async () => ({})),
    callAction: async () => ({}),
  };
  const bot = new BotOrchestrator(
    adapter,
    runtime,
    'persona',
    'bot',
    { stickerPath: () => null, voicePath: () => null },
    opts,
  );
  bot.start();
  const emit = (text: string, peer = 'a') =>
    handler({ post_type: 'message', message_type: 'private', user_id: peer, message: text });
  return { runtime, adapter, bot, emit, error };
}

it('同会话按接收顺序生成与交付，不同会话仍可并行，下一轮保留完整历史', async () => {
  const f = fixture();
  const gate = deferred();
  const chat = vi.spyOn(f.runtime, 'chat').mockImplementation(async (input) => {
    if (input.text === 'first') await gate.promise;
    return result(`reply-${input.text}`);
  });
  f.emit('first');
  f.emit('second');
  f.emit('other', 'b');
  try {
    await vi.waitFor(() =>
      expect(chat.mock.calls.map(([input]) => input.text)).toEqual(['first', 'other']),
    );
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.adapter.sendMessage).toHaveBeenCalledTimes(3));
  expect(
    chat.mock.calls
      .find(([input]) => input.text === 'second')?.[0]
      .history.map((turn) => turn.text),
  ).toEqual(['first', 'reply-first']);
  f.emit('third');
  await vi.waitFor(() => expect(f.adapter.sendMessage).toHaveBeenCalledTimes(4));
  expect(chat.mock.calls.at(-1)![0].history.map((turn) => turn.text)).toEqual([
    'first',
    'reply-first',
    'second',
    'reply-second',
  ]);
  await f.bot.stop();
});

it('失败释放执行槽，不重试失败生成，后续消息继续处理', async () => {
  const f = fixture({ maxConcurrentChats: 1 });
  const chat = vi.spyOn(f.runtime, 'chat').mockImplementation(async ({ text }) => {
    if (text === 'bad') throw new Error('合成失败');
    return result(text);
  });
  f.emit('bad');
  f.emit('good');
  await vi.waitFor(() => expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1));
  expect(chat.mock.calls.map(([input]) => input.text)).toEqual(['bad', 'good']);
  await f.bot.stop();
});

it('单会话与总等待队列均有界，超限明确告警，不执行未受理消息', async () => {
  const f = fixture({ maxConcurrentChats: 1, maxQueuedMessages: 2, maxQueuedPerChat: 1 });
  const gate = deferred();
  const chat = vi.spyOn(f.runtime, 'chat').mockImplementation(async ({ text }) => {
    if (text === 'running') await gate.promise;
    return result(text);
  });
  f.emit('running');
  await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
  f.emit('queued');
  f.emit('rejected-chat');
  f.emit('other', 'b');
  f.emit('rejected-total', 'c');
  try {
    expect(
      f.error.mock.calls.filter(([message]) => String(message).includes('队列已满')),
    ).toHaveLength(2);
  } finally {
    gate.resolve();
  }
  await vi.waitFor(() => expect(f.adapter.sendMessage).toHaveBeenCalledTimes(3));
  expect(chat.mock.calls.map(([input]) => input.text)).not.toContain('rejected-chat');
  expect(chat.mock.calls.map(([input]) => input.text)).not.toContain('rejected-total');
  await f.bot.stop();
});

it('停止取消当前生成并清空等待项，迟到结果与停止后事件均不发送', async () => {
  const f = fixture({ maxConcurrentChats: 1 });
  const gate = deferred();
  const chat = vi.spyOn(f.runtime, 'chat').mockImplementation(async () => {
    await gate.promise;
    return result('late');
  });
  f.emit('first');
  f.emit('queued');
  await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
  const stopped = f.bot.stop();
  gate.resolve();
  await stopped;
  expect(chat.mock.calls[0]![0].signal?.aborted).toBe(true);
  f.emit('after-stop');
  await Promise.resolve();
  expect(chat).toHaveBeenCalledTimes(1);
  expect(f.adapter.sendMessage).not.toHaveBeenCalled();
});

it('停止打断分条发送的等待，不发送下一条', async () => {
  const f = fixture();
  vi.spyOn(f.runtime, 'chat').mockResolvedValue({
    ...result('reply'),
    renderedTurns: ['one', 'two'],
    replyDelayMs: 10_000,
  });
  f.emit('hello');
  await vi.waitFor(() => expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1));
  await f.bot.stop();
  expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1);
});

it('单条回复不会额外等待分条延迟，下一条可立即生成', async () => {
  const f = fixture();
  vi.spyOn(f.runtime, 'chat').mockResolvedValue({ ...result('reply'), replyDelayMs: 10_000 });
  f.emit('one');
  f.emit('two');
  try {
    await vi.waitFor(() => expect(f.adapter.sendMessage).toHaveBeenCalledTimes(2));
  } finally {
    await f.bot.stop();
  }
});
