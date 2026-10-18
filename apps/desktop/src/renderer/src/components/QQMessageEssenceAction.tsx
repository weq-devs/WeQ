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

export function QQMessageEssenceAction({
  conversation,
  message,
  onClose,
}: {
  conversation: Conversation;
  message: Message;
  onClose: () => void;
}) {
  const session = useQQWriteSession(`essence:${conversation.id}:${message.id}`);
  const mutation = trpc.account.qqWrite.groupEssence.useMutation();
  const utils = trpc.useUtils();
  const push = useToast((state) => state.push);
  if (conversation.type !== 'group') return null;
  const target = qqEssenceTarget(conversation, message);
  const active = conversation.group.essenceSeqs?.includes(message.msgSeq ?? '') ?? false;
  const reason = !target
    ? '缺少可信的消息序号或 random'
    : !session.available
      ? 'QQ 在线能力未就绪'
      : '';
  async function submit() {
    if (!target) return;
    let outcome: QQWriteOutcome = { state: 'unconfirmed' };
    const ok = await session.run(
      async (binding) => {
        outcome = await mutation.mutateAsync({ ...binding, ...target, enable: !active });
        return outcome;
      },
      async () => {
        await Promise.all([
          utils.account.listGroupEssenceSeqs.invalidate(),
          utils.account.listGroupEssenceMessages.invalidate(),
          utils.account.getGroupEssenceWithContent.invalidate(),
        ]);
      },
    );
    if (ok) {
      push({ tone: 'info', title: qqWriteOutcomeText(outcome) });
      onClose();
    }
  }
  return (
    <>
      <button
        type="button"
        title={reason || (active ? '取消精华' : '设为精华')}
        disabled={Boolean(reason) || session.busy}
        onClick={() => {
          void submit();
        }}
      >
        {active ? <StarOff size={17} /> : <Star size={17} />}
        <span>{active ? '取消精华' : '设为精华'}</span>
      </button>
      <QQWriteResult result={session.result?.error ? session.result : null} />
    </>
  );
}
