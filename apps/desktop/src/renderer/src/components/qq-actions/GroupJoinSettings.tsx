import { useState } from 'react';
import { Save } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDraftProtection } from '../../lib/draftClose';
import { Row } from '../settings/controls';
import { ActionFeedback, useQQAction, useQQGroupPermissions } from './shared';

type JoinMode = 1 | 2 | 3 | 4 | 5;
function joinMode(value: number | null | undefined): JoinMode | '' {
  if (value === 55) return 5;
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : '';
}

/**
 * 加群方式（群管理章节）。
 *
 * 呈现层按设置页语言：Card 标题 + Row（label 在左、控件在右）+ 带文字的保存按钮；
 * 协议调用、自动回读、草稿保护都保持原样，没有新增请求。
 */
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
  useDraftProtection(draft, a.busy);
  const currentMode = joinMode(query.data?.option);
  const mode = draft?.mode ?? currentMode;
  const question = draft?.question ?? query.data?.question ?? '';
  const answer = draft?.answer ?? '';
  const disabled = a.disabled || !permissions.data?.canManage;
  const asking = mode === 4 || mode === 5;
  const canSave =
    !disabled &&
    !query.isFetching &&
    Boolean(query.data) &&
    mode !== '' &&
    (!asking || Boolean(question.trim())) &&
    (mode !== 4 || Boolean(answer.trim()));
  return (
    <div className="weq-join-settings">
      <Row
        label="谁可以加入"
        desc="直接写入 QQ 群设置，保存后生效"
        control={
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
        }
      />
      {asking ? (
        <Row
          label="入群问题"
          desc={mode === 4 ? '答对问题才能加入' : '答完问题后仍需管理员审核'}
          control={
            <input
              aria-label="加群问题"
              placeholder="加群问题"
              value={question}
              maxLength={256}
              disabled={disabled}
              onChange={(event) => setDraft({ mode, question: event.target.value, answer })}
            />
          }
        />
      ) : null}
      {mode === 4 ? (
        <Row
          label="问题答案"
          desc="只有你和管理员能看到"
          control={
            <input
              aria-label="加群答案"
              placeholder="请输入新的正确答案"
              value={answer}
              maxLength={256}
              disabled={disabled}
              onChange={(event) => setDraft({ mode, question, answer: event.target.value })}
            />
          }
        />
      ) : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      <div className="weq-qq-action-bar">
        <button
          type="button"
          aria-label="保存加群方式"
          className="weq-set-btn"
          disabled={!canSave}
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
        >
          <Save size={15} />
          保存加群方式
        </button>
      </div>
      <ActionFeedback action={a} />
    </div>
  );
}
