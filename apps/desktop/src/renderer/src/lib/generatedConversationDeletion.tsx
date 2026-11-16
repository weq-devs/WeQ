import type { Conversation } from '../im-template/template/types';
import { conversationRowName } from './conversationViews';

export function generatedConversationDeletion(
  rows: readonly Conversation[],
  running: readonly Conversation[],
) {
  const assistants = rows.filter((row) => row.generated?.kind === 'assistant');
  const personas = rows.filter((row) => row.generated?.kind === 'persona');
  const groups = rows.filter((row) => row.generated?.kind === 'group');
  const clones = personas.length + groups.length;
  const label = assistants.length ? (clones ? '克隆和助手会话' : '助手会话') : '克隆会话';
  return {
    title: `永久删除${label}`,
    message: (
      <>
        <p>
          将永久删除以下 <span className="weq-number weq-number-inherit">{rows.length}</span> 个
          {label}，无法恢复，也不会进入“已删除会话”。
        </p>
        {personas.length ? (
          <p>所选克隆角色及其全部私聊历史和记忆会一并删除，群聊中的既有消息会保留。</p>
        ) : null}
        {groups.length ? (
          <p>所选克隆群及其全部会话数据会一并删除，不会删除成员对应的克隆体。</p>
        ) : null}
        {assistants.length ? <p>仅删除所选助手会话及其消息，其他助手会话不受影响。</p> : null}
        <ul>
          {rows.map((row) => (
            <li key={row.id}>{conversationRowName(row)}</li>
          ))}
        </ul>
        {running.length ? (
          <p>
            其中 {running.map(conversationRowName).join('、')}{' '}
            正在生成回答。确认后会先停止这些运行，等待写入结束，再永久删除；其他运行不受影响。
          </p>
        ) : null}
      </>
    ),
  };
}
