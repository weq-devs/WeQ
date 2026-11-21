import { FormSelect } from '../FormSelect';
import { useState } from 'react';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useDraftProtection } from '../../lib/draftClose';
import { Row } from '../settings/controls';
import { ActionFeedback } from './shared';
import { useQQAction } from './shared.shared';

type JoinMode = 1 | 2 | 3 | 4 | 5;
type QuestionMode = 4 | 5;
function joinMode(value: number | null | undefined): JoinMode | '' {
  if (value === 55) return 5;
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 ? value : '';
}

export function GroupJoinSettings({ groupId, canManage }: { groupId: number; canManage: boolean }) {
  const a = useQQAction(`join-settings:${groupId}`);
  const autoRefresh = useQQAutoRefresh(a.available);
  const query = trpc.account.qqActions.groupJoinSettings.useQuery(
    { ...a.binding!, groupId },
    autoRefresh,
  );
  const [draft, setDraft] = useState<{
    mode: QuestionMode;
    question: string;
    answer: string;
  } | null>(null);
  useDraftProtection(draft, a.pending);
  const currentMode = joinMode(query.data?.option);
  const mode = draft?.mode ?? currentMode;
  const question = draft?.question ?? query.data?.question ?? '';
  const answer = draft?.answer ?? '';
  const disabled = a.disabled || !canManage;
  const asking = mode === 4 || mode === 5;
  const canEdit = !disabled && !query.isFetching && Boolean(query.data);
  const canSave = canEdit && Boolean(question.trim()) && (mode !== 4 || Boolean(answer.trim()));

  function submit(targetMode: JoinMode) {
    if (!canEdit) return;
    const targetQuestion = targetMode === 4 || targetMode === 5 ? question : '';
    void a.perform(
      (binding) =>
        client.account.qqActions.groupSettings.mutate({
          ...binding,
          groupId,
          action: 'join',
          addType: targetMode,
          question: targetQuestion,
          answer: targetMode === 4 ? answer : undefined,
        }),
      undefined,
      undefined,
      {
        requireReadback: true,
        readback: async () => {
          const result = await query.refetch();
          if (result.error) throw result.error;
          const matched =
            joinMode(result.data?.option) === targetMode &&
            ((targetMode !== 4 && targetMode !== 5) || result.data?.question === targetQuestion);
          if (matched) setDraft(null);
          return matched;
        },
      },
    );
  }
  return (
    <div className="weq-group-management-join">
      <Row
        label="入群验证"
        desc={canManage && !asking ? '无需填写问题的选项会立即提交' : undefined}
        control={
          <FormSelect
            className="weq-set-input"
            aria-label="加群方式"
            value={mode}
            disabled={!canEdit}
            onChange={(event) => {
              const next = joinMode(Number(event.target.value));
              if (!next || next === mode) return;
              if (next === 4 || next === 5) {
                setDraft({ mode: next, question, answer: '' });
              } else if (next === currentMode) {
                setDraft(null);
              } else {
                submit(next);
              }
            }}
          >
            <option value="" data-placeholder>
              {query.isFetching ? '读取中…' : '尚未读取加群方式'}
            </option>
            <option value={1}>允许任何人</option>
            <option value={2}>需要审核</option>
            <option value={3}>不允许加入</option>
            <option value={4}>正确回答问题</option>
            <option value={5}>回答问题并审核</option>
          </FormSelect>
        }
      />
      {asking ? (
        <Row
          label="入群问题"
          desc={mode === 4 ? '答对问题才能加入' : '答完问题后仍需管理员审核'}
          control={
            <input
              className="weq-set-input"
              aria-label="加群问题"
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
              className="weq-set-input"
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
      {query.error ? (
        <p className="weq-qq-write-result" role="alert">
          入群验证读取失败：{query.error.message}
        </p>
      ) : null}
      {canManage && asking && (
        <div className="weq-group-management-join-actions">
          <button
            type="button"
            aria-label="保存加群方式"
            className="weq-set-btn weq-set-btn-primary"
            disabled={!canSave}
            onClick={() => submit(mode)}
          >
            保存加群方式
          </button>
        </div>
      )}
      <ActionFeedback action={a} />
    </div>
  );
}
