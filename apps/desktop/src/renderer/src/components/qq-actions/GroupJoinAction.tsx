import { useEffect, useId, useRef, useState } from 'react';
import { Send, Search, X } from 'lucide-react';
import type { GroupJoinInfo } from '@weq/protocol';
import { client } from '../../trpc/client';
import { Modal } from '../Dialog';
import { ActionFeedback, ActionIcon, useQQAction, withQQAccountScope } from './shared';
import '../../styles/self-profile.css';

type Target = GroupJoinInfo & { token: string; alreadyMember: boolean };
function GroupJoinActionBody({ onClose }: { onClose: () => void }) {
  const a = useQQAction('join-group');
  const titleId = useId();
  const [share, setShare] = useState(''),
    [answer, setAnswer] = useState('');
  const [target, setTarget] = useState<Target | null>(null),
    [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  const revision = useRef(0),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current++;
    };
  }, []);
  async function prepare() {
    if (!a.binding || a.disabled || reading) return;
    const run = ++revision.current;
    setTarget(null);
    setError('');
    setReading(true);
    try {
      const result = await client.account.qqActions.prepareJoin.mutate({ ...a.binding, share });
      if (mounted.current && run === revision.current) setTarget(result);
    } catch (cause) {
      if (mounted.current && run === revision.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && run === revision.current) setReading(false);
    }
  }
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      width={480}
      centered
      className="weq-qq-join-dialog"
    >
      <header className="weq-self-profile-header">
        <h2 id={titleId}>申请加入 QQ 群</h2>
        <ActionIcon label="关闭加群窗口" onClick={onClose}>
          <X size={18} />
        </ActionIcon>
      </header>
      <div className="weq-self-profile-body weq-qq-action-form">
        <div className="weq-qq-action-bar">
          <input
            aria-label="QQ 群分享链接"
            placeholder="QQ 群分享链接"
            value={share}
            maxLength={8192}
            onChange={(e) => {
              revision.current++;
              setShare(e.target.value);
              setTarget(null);
              setAnswer('');
              setReading(false);
            }}
          />
          <ActionIcon
            label="读取加群资料"
            disabled={a.disabled || reading || !share.trim()}
            onClick={() => void prepare()}
          >
            <Search size={16} />
          </ActionIcon>
        </div>
        {reading && <p role="status">读取群资料中…</p>}
        {error && <p role="alert">{error}</p>}
        {target && (
          <>
            <strong>
              {target.name || 'QQ 群'} · {target.groupId}
            </strong>
            {target.alreadyMember ? (
              <p role="status">当前账号已经在群内</p>
            ) : target.option === 3 ? (
              <p role="status">该群当前不允许加入</p>
            ) : (
              <>
                <p role="status">
                  {target.questionState === 'available'
                    ? target.question
                    : target.questionState === 'not-required'
                      ? '该群无需回答验证问题'
                      : '无法获取验证问题'}
                </p>
                <textarea
                  aria-label="入群回答"
                  placeholder="入群回答或申请留言"
                  value={answer}
                  maxLength={1024}
                  onChange={(e) => setAnswer(e.target.value)}
                />
                <ActionIcon
                  label="提交入群申请"
                  disabled={a.disabled || (target.questionState === 'available' && !answer.trim())}
                  onClick={() =>
                    void a.perform(
                      (b) =>
                        client.account.qqActions.join.mutate({
                          ...b,
                          groupId: target.groupId,
                          token: target.token,
                          answer,
                        }),
                      async () => setTarget(null),
                      target.questionState === 'unavailable'
                        ? `尚未获取群 ${target.groupId} 的验证问题，仍提交所填回答？`
                        : `向 QQ 群 ${target.groupId} 提交入群申请？`,
                      {
                        readback: async () => {
                          const rows = await client.account.listAllGroups.query();
                          return rows.some(
                            (row) => String(row.groupCode) === String(target.groupId),
                          );
                        },
                      },
                    )
                  }
                >
                  <Send size={17} />
                </ActionIcon>
              </>
            )}
          </>
        )}
        <ActionFeedback action={a} />
      </div>
    </Modal>
  );
}
export const GroupJoinAction = withQQAccountScope(GroupJoinActionBody);
