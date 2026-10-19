import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AccountSession } from '@weq/account';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationStore, MAX_CONVERSATION_TURNS } from '../src/account/agentlab_conversation';
import {
  searchGeneratedMessages,
  type GeneratedSearchSources,
} from '../src/account/generated_search';
import { UnifiedSearchService } from '../src/account/unified_search';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function storeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'weq-generated-search-'));
  directories.push(directory);
  const file = join(directory, 'conversations.json');
  const raw = JSON.stringify({
    'p:s': [
      { role: 'user', text: '同一内容', ts: 1 },
      { role: 'user', text: '同一内容', ts: 1 },
      { role: 'assistant', text: '旧答复', ts: 2 },
    ],
  });
  await writeFile(file, raw);
  return { file, raw, store: new ConversationStore(file) };
}

describe('生成对话身份', () => {
  it('旧数据读取身份稳定、重复正文不撞 ID，不因搜索读取写回原文件', async () => {
    const f = await storeFixture();
    const first = f.store.get('p:s').map((turn) => turn.id);
    expect(new Set(first).size).toBe(3);
    expect(new ConversationStore(f.file).get('p:s').map((turn) => turn.id)).toEqual(first);
    expect(await readFile(f.file, 'utf8')).toBe(f.raw);
  });

  it('裁剪和补全正文后保留已有身份，新回合始终唯一', async () => {
    const f = await storeFixture();
    const previous = f.store.get('p:s');
    f.store.patchLastAssistant('p:s', { text: '补全答复', ts: 3 });
    expect(new ConversationStore(f.file).get('p:s').at(-1)?.id).toBe(previous.at(-1)?.id);
    f.store.append(
      'p:s',
      Array.from({ length: MAX_CONVERSATION_TURNS - 1 }, () => ({
        role: 'user' as const,
        text: '重复新回合',
        ts: 4,
      })),
    );
    const next = new ConversationStore(f.file).get('p:s');
    expect(next).toHaveLength(MAX_CONVERSATION_TURNS);
    expect(next[0]?.id).toBe(previous[2]?.id);
    expect(new Set(next.map((turn) => turn.id)).size).toBe(MAX_CONVERSATION_TURNS);
  });
});

function sources(): GeneratedSearchSources {
  return {
    agentLab: {
      listPersonas: () => [{ id: 'p', name: '合成克隆' }],
      listGroups: () => [{ id: 'g', name: '合成群' }],
      listPersonaSessions: () => [{ id: 'ps', title: '私聊会话' }],
      getPersonaSessionConversation: () => [{ id: 'p1', text: 'Hello 世界', ts: 20 }],
      getConversation: () => [{ id: 'old-p', text: '旧版 Hello', ts: 1 }],
      listGroupSessions: () => [{ id: 'gs', title: '群会话' }],
      getGroupSessionConversation: () => [{ id: 'g1', text: 'HELLO 群消息', ts: 30 }],
      getGroupMessages: () => [{ id: 'old-g', text: '旧版 hello 群', ts: 2 }],
    },
    assistant: {
      listSessions: () => [{ id: 'as', title: '助手会话' }],
      getConversation: () => [{ id: 'a1', text: 'Hello 助手', ts: 40 }],
    },
  };
}

describe('当前账号生成内容搜索', () => {
  it('私聊、群聊与旧版记录均返回可定位身份，助手不混入克隆类别', () => {
    const data = sources();
    expect(
      searchGeneratedMessages(data, 'cloneMessage', 'hello').map((hit) => [
        hit.kind,
        hit.sessionId,
        hit.messageId,
      ]),
    ).toEqual([
      ['group', 'gs', 'g1'],
      ['persona', 'ps', 'p1'],
      ['group', null, 'old-g'],
      ['persona', null, 'old-p'],
    ]);
    expect(
      searchGeneratedMessages(data, 'assistantMessage', 'hello').map((hit) => hit.messageId),
    ).toEqual(['a1']);
    expect(searchGeneratedMessages(data, 'cloneMessage', '   ')).toEqual([]);
  });

  it('独立账号源不串用，结果直接反映删除而非持有过期排名', async () => {
    const first = sources();
    const second = sources();
    second.assistant.getConversation = () => [{ id: 'b1', text: '另一个账号 HELLO', ts: 50 }];
    const a = new UnifiedSearchService({} as AccountSession, { generatedSources: () => first });
    const b = new UnifiedSearchService({} as AccountSession, { generatedSources: () => second });
    expect(
      (await a.slowSearch('hello', 3, ['assistantMessage'])).assistantMessages[0]?.messageId,
    ).toBe('a1');
    expect(
      (await b.slowSearch('hello', 3, ['assistantMessage'])).assistantMessages[0]?.messageId,
    ).toBe('b1');
    first.assistant.getConversation = () => [];
    expect((await a.slowSearch('hello', 3, ['assistantMessage'])).assistantMessages).toEqual([]);
  });

  it('范围选择、预览条数和更多分页真实执行，不触发 QQ 查询或其它生成源', async () => {
    const data = sources();
    const assistant = vi.spyOn(data.assistant, 'listSessions');
    const service = new UnifiedSearchService({} as AccountSession, {
      generatedSources: () => data,
    });
    const preview = await service.slowSearch('hello', 2, ['cloneMessage']);
    expect(preview.cloneMessages).toHaveLength(2);
    expect(assistant).not.toHaveBeenCalled();
    const page = await service.moreSearch('cloneMessage', 'hello', 2, 1);
    expect(page.total).toBe(4);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({ messageId: 'old-g', sessionId: null });
  });
});
