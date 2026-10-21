import { useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { ActionFeedback, SaveAction, useQQAction, useQQGroupPermissions } from './shared';

type JoinMode = 1 | 2 | 3 | 4 | 5;
function joinMode(value: number | null | undefined): JoinMode | '' {
  if (value === 55) return 5;
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : '';
}

export function GroupJoinSettings({ groupId }: { groupId: number }) {
  const a = useQQAction(`join-settings:${groupId}`);
  const permissions = useQQGroupPermissions(groupId, a);
  const autoRefresh = useQQAutoRefresh(a.available);
  const query = trpc.account.qqActions.groupJoinSettings.useQuery(
    { ...a.binding!, groupId },
    autoRefresh,
  );
  const [draft, setDraft] = useState<{
    mode: JoinMode | '';
    question: string;
    answer: string;
  } | null>(null);
  const currentMode = joinMode(query.data?.option);
  const mode = draft?.mode ?? currentMode;
  const question = draft?.question ?? query.data?.question ?? '';
  const answer = draft?.answer ?? '';
  const disabled = a.disabled || !permissions.data?.canManage;
  return (
    <div className="weq-qq-action-form weq-qq-join-settings">
      <div className="weq-qq-action-bar">
        <select
          aria-label="加群方式"
          value={mode}
          disabled={disabled || query.isFetching}
          onChange={(event) =>
            setDraft({ mode: joinMode(Number(event.target.value)), question, answer: '' })
          }
        >
          <option value="">尚未读取加群方式</option>
          <option value={1}>允许任何人</option>
          <option value={2}>需要审核</option>
          <option value={3}>不允许加入</option>
          <option value={4}>正确回答问题</option>
          <option value={5}>回答问题并审核</option>
        </select>
      </div>
      {query.error && <p role="alert">{query.error.message}</p>}
      {(mode === 4 || mode === 5) && (
        <>
          <input
            aria-label="加群问题"
            placeholder="加群问题"
            value={question}
            maxLength={256}
            disabled={disabled}
            onChange={(event) => setDraft({ mode, question: event.target.value, answer })}
          />
          {mode === 4 && (
            <input
              aria-label="加群答案"
              placeholder="请输入新的正确答案"
              value={answer}
              maxLength={256}
              disabled={disabled}
              onChange={(event) => setDraft({ mode, question, answer: event.target.value })}
            />
          )}
        </>
      )}
      <SaveAction
        label="保存加群方式"
        disabled={
          disabled ||
          query.isFetching ||
          !query.data ||
          mode === '' ||
          ((mode === 4 || mode === 5) && !question.trim()) ||
          (mode === 4 && !answer.trim())
        }
        onClick={() => {
          if (mode === '') return;
          const targetMode = mode;
          void a.perform(
            (binding) =>
              client.account.qqActions.groupSettings.mutate({
                ...binding,
                groupId,
                action: 'join',
                addType: targetMode,
                question,
                answer: targetMode === 4 ? answer : undefined,
              }),
            undefined,
            `修改 QQ 群 ${groupId} 的加群方式？`,
            {
              readback: async () => {
                const result = await query.refetch();
                if (result.error) throw result.error;
                const matched =
                  joinMode(result.data?.option) === targetMode &&
                  ((targetMode !== 4 && targetMode !== 5) || result.data?.question === question);
                if (matched) setDraft(null);
                return matched;
              },
            },
          );
        }}
      />
      <ActionFeedback action={a} />
    </div>
  );
}
