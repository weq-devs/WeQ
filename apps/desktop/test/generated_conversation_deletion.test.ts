import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ConversationMenuTarget } from '../src/renderer/src/components/ConversationMenuTarget';
import { virtualConversationRow } from '../src/renderer/src/lib/conversationDirectory';
import { assistantConversationRow } from '../src/renderer/src/lib/conversationDirectoryRows';
import { generatedConversationDeletion } from '../src/renderer/src/lib/generatedConversationDeletion';

const assistant = assistantConversationRow({ id: 's1', title: '会议整理', updatedAt: 12345 });
const otherAssistant = assistantConversationRow({ id: 's2', title: '学习答疑', updatedAt: 12345 });
const persona = virtualConversationRow({
  id: 'virtual:persona:p1',
  kind: 'persona',
  ownerId: 'p1',
  name: '合成克隆角色',
});
const group = virtualConversationRow({
  id: 'virtual:group:g1',
  kind: 'group',
  ownerId: 'g1',
  name: '合成克隆群',
});
function render(message: React.ReactNode) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(message);
  return host;
}

it.each([[assistant], [assistant, otherAssistant]])(
  '仅删除助手时，确认标题和正文不出现克隆删除说明：%j',
  (...rows) => {
    const prompt = generatedConversationDeletion(rows, []);
    expect(prompt.title).toBe('永久删除助手会话');
    const host = render(prompt.message);
    expect(host.textContent).toContain('仅删除所选助手会话及其消息，其他助手会话不受影响');
    expect(host.textContent).not.toContain('克隆');
    expect(host.querySelectorAll('li')).toHaveLength(rows.length);
    expect(host.textContent).toContain('无法恢复，也不会进入“已删除会话”');
    expect(host.textContent).not.toContain('正在生成回答');
  },
);
it('删除克隆角色时说明私聊历史、记忆及群消息保留，不混入助手或克隆群说明', () => {
  const prompt = generatedConversationDeletion([persona], []);
  const host = render(prompt.message);
  expect(prompt.title).toBe('永久删除克隆会话');
  expect(host.textContent).toContain('所选克隆角色及其全部私聊历史和记忆会一并删除');
  expect(host.textContent).toContain('群聊中的既有消息会保留');
  expect(host.textContent).not.toContain('助手');
  expect(host.textContent).not.toContain('所选克隆群');
});
it('删除克隆群时说明群数据与成员保留，不混入角色或助手删除说明', () => {
  const prompt = generatedConversationDeletion([group], []);
  const host = render(prompt.message);
  expect(prompt.title).toBe('永久删除克隆会话');
  expect(host.textContent).toContain('所选克隆群及其全部会话数据会一并删除');
  expect(host.textContent).toContain('不会删除成员对应的克隆体');
  expect(host.textContent).not.toContain('所选克隆角色');
  expect(host.textContent).not.toContain('助手');
});
it('混选时分别说明实际所选类型，仅列出正在运行的所选会话', () => {
  const prompt = generatedConversationDeletion([persona, group, assistant], [assistant]);
  const host = render(prompt.message);
  expect(prompt.title).toBe('永久删除克隆和助手会话');
  expect(host.querySelectorAll('li')).toHaveLength(3);
  expect(host.textContent).toContain('所选克隆角色');
  expect(host.textContent).toContain('所选克隆群');
  expect(host.textContent).toContain('仅删除所选助手会话');
  expect(host.querySelector('p:last-child')!.textContent).toContain('会议整理 正在生成回答');
  expect(host.querySelector('p:last-child')!.textContent).not.toContain(
    persona.otherUser?.displayName,
  );
  expect(host.textContent).toContain('等待写入结束，再永久删除；其他运行不受影响');
});
it('助手和角色混选时不出现未选克隆群的删除说明', () => {
  const prompt = generatedConversationDeletion([persona, assistant], []);
  expect(render(prompt.message).textContent).not.toContain('所选克隆群');
});
it('克隆群菜单显示克隆群聊，不显示内部标识或号码复制', () => {
  const host = render(
    h(ConversationMenuTarget, {
      name: '合成克隆群',
      identity: 'virtual:group:g1',
      kind: group.type,
      generated: group.generated,
      count: 1,
    }),
  );
  expect(host.querySelector('small')!.textContent).toBe('克隆群聊');
  expect(host.querySelector('.weq-conversation-copy-number')).toBeNull();
});
