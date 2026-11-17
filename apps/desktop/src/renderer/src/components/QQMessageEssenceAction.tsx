import { StarOff } from 'lucide-react';
import { FEATURE_ICONS } from '../lib/featureIcons';
import { MessageMenuButton } from './MessageMenuButton';
import { client, trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { qqEssenceTarget } from '../lib/qqEssenceTarget';
import type { Conversation, Message } from '../im-template/template/types';
import { QQWriteResult } from './QQWriteControls';
import { groupPermission, qqResourceOwnedBy } from '@weq/service/qq-permissions';
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
  removeLabel,
}: {
  conversation: Conversation;
  message: Message;
  onClose: () => void;
  removeLabel?: string;
}) {
  if (conversation.type !== 'group') return null;
  return (
    <QQMessageEssencePermission
      conversation={conversation}
      message={message}
      onClose={onClose}
      removeLabel={removeLabel}
    />
  );
}

function QQMessageEssencePermission({
  conversation,
  message,
  onClose,
  removeLabel,
}: {
  conversation: Extract<Conversation, { type: 'group' }>;
  message: Message;
  onClose: () => void;
  removeLabel?: string;
}) {
  const session = useQQWriteSession(`essence-permission:${conversation.id}:${message.id}`);
  const target = qqEssenceTarget(conversation, message);
  const active = conversation.group.essenceSeqs?.includes(message.msgSeq ?? '') ?? false;
  const permissions = trpc.account.qqWrite.groupEssencePermission.useQuery(
    { ...session.binding!, groupId: target?.groupId ?? 0, sequence: target?.sequence ?? 0 },
    { enabled: active && Boolean(target) && session.available, staleTime: 0, retry: false },
  );
  const groupState = trpc.account.qqActions.groupPermissions.useQuery(
    { ...session.binding!, groupId: target?.groupId ?? 0 },
    { enabled: Boolean(target) && session.available, staleTime: 15_000, retry: false },
  );
  const allowed = groupPermission(active ? 'essenceRemove' : 'essenceSet', {
    ...groupState.data,
    role: groupState.data ? groupState.data.role : conversation.group.role,
    canRemove: permissions.data?.canRemove,
    isSelf:
      permissions.data?.isSelf ??
      qqResourceOwnedBy(message.senderId, {
        uid: groupState.data?.selfUid,
        uin: session.binding?.expectedAccountUin,
      }),
  });
  if (!allowed) return null;
  return (
    <QQEssenceAction
      target={target}
      initialActive={active}
      allowed={allowed}
      onClose={onClose}
      removeLabel={removeLabel}
    />
  );
}

export function QQEssenceAction({
  target,
  initialActive,
  allowed,
  onClose,
  iconOnly = false,
  removeLabel = '取消精华',
}: {
  target: EssenceTarget | null;
  initialActive: boolean;
  allowed: boolean;
  onClose?: () => void;
  iconOnly?: boolean;
  removeLabel?: string;
}) {
  const session = useQQWriteSession(`essence:${target?.groupId}:${target?.sequence}`);
  const mutation = trpc.account.qqWrite.groupEssence.useMutation();
  const utils = trpc.useUtils();
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
        ? '在线能力受限，无法设置或取消精华消息'
        : '';
  async function submit() {
    if (!target || reason) return;
    const operation = useQQEssence.getState().begin(source, target);
    if (operation === null) return;
    try {
      const ok = await session.run(
        (binding) => mutation.mutateAsync({ ...binding, ...target, enable: !active }),
        async () => {
          await Promise.all([
            utils.account.listGroupEssenceSeqs.invalidate(),
            utils.account.listGroupEssenceMessages.invalidate(),
            utils.account.getGroupEssenceWithContent.invalidate(),
            utils.account.getGroupEssencePageWithContent.invalidate(),
          ]);
        },
        {
          requireReadback: true,
          readbackSuccessText: active ? '已取消精华' : '已设为精华',
          readback: async () => {
            const sequences = await client.account.listGroupEssenceSeqs.query({
              groupCode: String(target.groupId),
            });
            return sequences.includes(String(target.sequence)) === !active;
          },
        },
      );
      if (ok) {
        useQQEssence.getState().finish(key, operation, !active, { state: 'confirmed' });
        onClose?.();
      }
    } finally {
      useQQEssence.getState().finish(key, operation);
    }
  }
  return (
    <>
      <MessageMenuButton
        type="button"
        className={iconOnly ? 'weq-set-iconbtn weq-essence-remove' : undefined}
        aria-label={active ? removeLabel : '设为精华'}
        title={reason || (active ? removeLabel : '设为精华')}
        disabled={Boolean(reason) || session.busy || Boolean(receipt?.pending)}
        onClick={() => {
          void submit();
        }}
      >
        {active ? (
          <StarOff size={17} aria-hidden />
        ) : (
          <FEATURE_ICONS.groupEssence size={17} aria-hidden />
        )}
        {!iconOnly && <span>{active ? removeLabel : '设为精华'}</span>}
      </MessageMenuButton>
      <QQWriteResult result={session.result} />
    </>
  );
}
