import { Star, StarOff } from 'lucide-react';
import { trpc } from '../trpc/client';
import {
  useQQWriteSession,
  qqWriteOutcomeText,
  type QQWriteOutcome,
} from '../hooks/useQQWriteSession';
import { qqEssenceTarget } from '../lib/qqEssenceTarget';
import type { Conversation, Message } from '../im-template/template/types';
import { useToast } from './Toast';
import { QQWriteResult } from './QQWriteControls';
import {
  essenceActive,
  essenceKey,
  essenceSource,
  useQQEssence,
  type EssenceTarget,
} from '../state/qqEssence';

export function QQMessageEssenceAction({
  conversation,
  message,
  onClose,
}: {
  conversation: Conversation;
  message: Message;
  onClose: () => void;
}) {
  if (conversation.type !== 'group') return null;
  return (
    <QQEssenceAction
      target={qqEssenceTarget(conversation, message)}
      initialActive={conversation.group.essenceSeqs?.includes(message.msgSeq ?? '') ?? false}
      allowed={conversation.group.role === 'owner' || conversation.group.role === 'admin'}
      onClose={onClose}
    />
  );
}

export function QQEssenceAction({
  target,
  initialActive,
  allowed,
  onClose,
  iconOnly = false,
}: {
  target: EssenceTarget | null;
  initialActive: boolean;
  allowed: boolean;
  onClose?: () => void;
  iconOnly?: boolean;
}) {
  const session = useQQWriteSession(`essence:${target?.groupId}:${target?.sequence}`);
  const mutation = trpc.account.qqWrite.groupEssence.useMutation();
  const utils = trpc.useUtils();
  const push = useToast((state) => state.push);
  const receipts = useQQEssence((state) => state.receipts);
  const source = essenceSource(session.binding);
  const key = essenceKey(source, target?.groupId ?? 0, target?.sequence ?? 0);
  const receipt = receipts[key];
  const active = target
    ? essenceActive(receipts, source, target.groupId, target.sequence, initialActive)
    : initialActive;
  const reason = !target
    ? '缺少可信的消息序号或 random'
    : !allowed
      ? '当前账号无权管理这条精华消息'
      : !session.available
        ? 'QQ 在线能力未就绪'
        : '';
  async function submit() {
    if (!target || reason) return;
    const operation = useQQEssence.getState().begin(source, target);
    if (operation === null) return;
    let outcome: QQWriteOutcome = { state: 'unconfirmed' };
    try {
      const ok = await session.run(
        async (binding) => {
          outcome = await mutation.mutateAsync({ ...binding, ...target, enable: !active });
          return outcome;
        },
        async () => {
          useQQEssence.getState().finish(key, operation, !active, outcome);
          await Promise.all([
            utils.account.listGroupEssenceSeqs.invalidate(),
            utils.account.listGroupEssenceMessages.invalidate(),
            utils.account.getGroupEssenceWithContent.invalidate(),
            utils.account.getGroupEssencePageWithContent.invalidate(),
          ]);
        },
        { backgroundRefresh: true },
      );
      if (ok) {
        push({ tone: 'info', title: qqWriteOutcomeText(outcome) });
        if (outcome.state === 'accepted' || outcome.state === 'confirmed') onClose?.();
      }
    } finally {
      useQQEssence.getState().finish(key, operation);
    }
  }
  return (
    <>
      <button
        type="button"
        className={iconOnly ? 'weq-set-iconbtn weq-essence-remove' : undefined}
        aria-label={active ? '取消精华' : '设为精华'}
        title={reason || (active ? '取消精华' : '设为精华')}
        disabled={Boolean(reason) || session.busy || Boolean(receipt?.pending)}
        onClick={() => {
          void submit();
        }}
      >
        {active ? <StarOff size={17} /> : <Star size={17} />}
        {!iconOnly && <span>{active ? '取消精华' : '设为精华'}</span>}
      </button>
      <QQWriteResult result={session.result} />
    </>
  );
}
