import { messageDetailsTarget } from '../../lib/messageDetailsTarget';
import { useEffect } from 'react';
import { BrainCircuit, Languages } from 'lucide-react';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { quoteBlockReason } from '../../im-template/template/composerQuote.shared';
import {
  MessageContextMenu,
  type MessageDetailsSelection,
} from '../../im-template/template/messageContextMenu';
import { grayTipOf } from '../../im-template/template/messageRow.shared';
import type { Conversation, Message } from '../../im-template/template/types';
import { conversationExportSelection, ordinaryQqConversation } from '../../lib/conversationActions';
import { messageForwardTarget } from '../../lib/messageForwardTarget';
import { messageHasIntentText } from '../../lib/intentTimeline';
import { messageMediaSaveSource, messageMediaTarget } from '../../lib/messageMediaTarget';
import { messageTranslationText } from '../../lib/messageTranslation';
import { exportMedia } from '../../lib/mediaExport';
import { messageContentClipboard, type MessageClipboard } from '../../lib/messageClipboard';
import { writeMentionClipboard } from '../../lib/mentionClipboard';
import { originalMessageClipboard } from '../../lib/originalMessageClipboard';
import { IS_WEB } from '../../lib/target.shared';
import { useRequestContentExport } from '../../state/contentSelection.shared';
import { trpc } from '../../trpc/client';
import type { useMediaSave } from '../MediaSaveControls.shared';
import { MessageMediaRevealAction } from '../MessageMediaRevealAction';
import { MessageMenuButton } from '../MessageMenuButton';
import { useToast } from '../Toast.shared';
import { MessageFavoriteEmojiAction } from '../qq-actions/MessageFavoriteEmojiAction';
import { recordMediaMessage, type RecordMessageActions } from './recordMessageActions';
import type { RecordMenuTrigger } from './useRecordContextMenu';

export type RecordMenuMessage = RecordMenuTrigger & {
  message: Message;
  elementIndex?: number;
  clipboard?: MessageClipboard;
};

export function RecordMessageMenu({
  menu,
  conversation,
  binding,
  mediaSave,
  actions,
  intentAvailable,
  intentPending,
  onAnalyze,
  onTranslate,
  onLocate,
  onSelect,
  onDetails,
  onResolveBody,
  onClose,
}: {
  menu: RecordMenuMessage;
  conversation: Conversation;
  binding?: QQWriteBinding;
  mediaSave: ReturnType<typeof useMediaSave>;
  actions?: RecordMessageActions;
  intentAvailable: boolean;
  intentPending: boolean;
  onAnalyze: (message: Message) => void;
  onTranslate: (message: Message, text: string) => void;
  onLocate: () => void;
  onSelect: () => void;
  onDetails: (selection: MessageDetailsSelection) => void;
  onResolveBody: (id: string, elements: NonNullable<Message['qqElements']>) => void;
  onClose: () => void;
}) {
  const requestExport = useRequestContentExport();
  const pushToast = useToast((state) => state.push);
  const target = messageDetailsTarget(binding, conversation, menu.message);
  const needsBody = Boolean(target && !menu.message.qqElements?.length);
  const record = trpc.account.messageRecordDetails.useQuery(target!, {
    enabled: needsBody,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  const body = record.data?.elements as Message['qqElements'];
  useEffect(() => {
    if (needsBody && body?.length) onResolveBody(menu.message.id, body);
  }, [needsBody, body, menu.message.id, onResolveBody]);
  const message = body?.length ? { ...menu.message, qqElements: body } : menu.message;
  const hasBody = Boolean(message.qqElements?.length);
  const mediaMessage = recordMediaMessage(message, menu.elementIndex);
  const forwardTarget =
    menu.elementIndex === undefined ? messageForwardTarget(message, menu.target) : undefined;
  const mediaTarget = forwardTarget ? undefined : messageMediaTarget(mediaMessage, menu.target);
  const mediaSource = mediaTarget && messageMediaSaveSource(mediaTarget);
  const image = ['pic', 'emoji', 'mface'].includes(mediaTarget?.kind ?? '')
    ? mediaTarget?.url
    : undefined;
  const translationText =
    binding && ordinaryQqConversation(conversation) && !grayTipOf(message) && hasBody
      ? messageTranslationText(message)
      : null;
  const exportSelection = requestExport && conversationExportSelection(conversation);
  const disabledSend = actions?.sendBlockedReason;
  const isMediaHit =
    menu.elementIndex !== undefined ||
    (menu.target instanceof Element && Boolean(menu.target.closest('[data-message-media-key]')));
  const copyImage = isMediaHit || message.qqElements?.length === 1 ? image : undefined;

  async function copy() {
    onClose();
    try {
      if (copyImage && !menu.clipboard) {
        const result = await exportMedia({ url: copyImage }, 'clipboard');
        if (!result.ok) throw new Error(result.error);
      } else {
        const content = menu.clipboard ?? messageContentClipboard(message.qqElements, message.body);
        const copied = await writeMentionClipboard(
          originalMessageClipboard(
            [message],
            { account: binding?.expectedAccountUin ?? '', conversation: conversation.id },
            content,
          ),
        );
        if (!copied) throw new Error('未能写入剪贴板，请重新复制。');
      }
      pushToast({ tone: 'success', title: '已复制' });
    } catch (error) {
      pushToast({
        tone: 'error',
        title: '复制失败',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return (
    <MessageContextMenu
      state={{ ...menu, message, forwardTarget, mediaTarget }}
      metadataPrecision={
        grayTipOf(message) ? undefined : conversation.generated ? 'millisecond' : 'second'
      }
      onClose={onClose}
      onLocate={onLocate}
      onCopy={copy}
      onViewDetails={onDetails}
      onReply={
        actions?.quote &&
        ((row) => {
          onClose();
          actions.quote?.(row);
        })
      }
      replyBlockedReason={
        hasBody
          ? quoteBlockReason(message)
          : record.isFetching
            ? '正在读取原消息'
            : '原消息正文暂不可用'
      }
      onForward={
        actions?.forward && hasBody
          ? (row) => {
              onClose();
              actions.forward?.([row]);
            }
          : undefined
      }
      forwardBlockedReason={disabledSend}
      onMultiSelect={onSelect}
      onAddToComposition={
        actions?.addMaterial && hasBody
          ? (row) => {
              onClose();
              actions.addMaterial?.([row]);
            }
          : undefined
      }
      onExport={
        exportSelection && forwardTarget
          ? (row) => {
              requestExport({
                owner: { ...exportSelection.owner, forwardTarget },
                scope: { type: 'items', ids: [row.id] },
              });
              onClose();
            }
          : undefined
      }
      onSaveMedia={
        mediaSource
          ? () => {
              onClose();
              void mediaSave.run(mediaSource);
            }
          : undefined
      }
      downloadDisabled={mediaSave.disabled}
      favoriteEmojiAction={
        binding && ordinaryQqConversation(conversation) && mediaTarget?.favoriteUrl ? (
          <MessageFavoriteEmojiAction
            url={mediaTarget.favoriteUrl}
            mediaLabel={mediaTarget.label}
            onClose={onClose}
          />
        ) : null
      }
      revealAction={
        !IS_WEB && mediaTarget && binding ? (
          <MessageMediaRevealAction
            key={JSON.stringify([binding, mediaTarget])}
            target={mediaTarget}
            binding={binding}
            onClose={onClose}
          />
        ) : null
      }
      translationAction={
        translationText ? (
          <MessageMenuButton
            type="button"
            disabled={Boolean(disabledSend)}
            title={disabledSend}
            onClick={() => {
              onClose();
              onTranslate(message, translationText);
            }}
          >
            <Languages size={17} />
            <span>翻译成中文</span>
          </MessageMenuButton>
        ) : null
      }
      intentAction={
        intentAvailable && hasBody && !grayTipOf(message) && messageHasIntentText(message) ? (
          <MessageMenuButton
            type="button"
            disabled={intentPending}
            title={intentPending ? '正在分析消息' : undefined}
            onClick={() => {
              onClose();
              onAnalyze(message);
            }}
          >
            <BrainCircuit size={17} />
            <span>意图感知</span>
          </MessageMenuButton>
        ) : null
      }
    />
  );
}
