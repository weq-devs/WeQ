import { Fragment, useMemo, type HTMLAttributes } from 'react';
import { Play } from 'lucide-react';
import { ShimmerImage } from '../ShimmerImage';
import { QqMessageContent } from '../QqMessageContent';
import { messageMediaKey } from '../../lib/messageMediaTarget';
import {
  MediaBrowseContext,
  useChatMediaItems,
  useChatMediaOpen,
} from '../ChatMediaGallery.shared';
import type { PreviewMedia } from '../mediaPreviewTypes';
import type { RenderElement } from '../QqMessageContent.shared';
import { conversationRecordTypeOf, isChatVideoAttachment } from '@weq/service/message-filter';
import type { ConversationRecordHit } from './types';
import { RecordDayHeading } from './recordDays';

export function RecordMediaResults({
  groups,
  type,
  contextProps,
}: {
  groups: Map<string, ConversationRecordHit[]>;
  type: 'media' | 'emoji';
  contextProps: (message: ConversationRecordHit) => HTMLAttributes<HTMLElement>;
}) {
  const items = useChatMediaItems();
  const open = useChatMediaOpen();
  const byMessage = useMemo(() => {
    const groups = new Map<string, Map<number, PreviewMedia>>();
    for (const media of items) {
      const order = media.order;
      if (!order?.rawId) continue;
      const row = groups.get(order.rawId) ?? new Map<number, PreviewMedia>();
      row.set(order.element, media);
      groups.set(order.rawId, row);
    }
    return groups;
  }, [items]);

  return [...groups].map(([day, messages]) => (
    <Fragment key={day}>
      <RecordDayHeading day={day} />
      <div className={`weq-record-media-grid is-${type}`}>
        {messages.flatMap((message) => {
          let mediaIndex = 0;
          return ((message.elements ?? []) as RenderElement[]).map((element, index) => {
            const order =
              element.type === 'pic' || element.type === 'video' || isChatVideoAttachment(element)
                ? mediaIndex++
                : -1;
            if (conversationRecordTypeOf(element) !== type) return null;
            const item = type === 'media' ? byMessage.get(message.msgId)?.get(order) : undefined;
            const key = `${message.msgId}:${index}`;
            if (item) {
              return (
                <button
                  {...contextProps(message)}
                  key={key}
                  type="button"
                  className="weq-record-media-thumbnail"
                  data-message-media-key={messageMediaKey(element)}
                  aria-label={item.title || (item.kind === 'video' ? '查看视频' : '查看图片')}
                  onClick={(event) => open?.(item.key, event.currentTarget.ownerDocument)}
                >
                  {item.kind === 'image' || item.poster ? (
                    <ShimmerImage
                      suspendOffscreen
                      mediaLoading
                      className="qq-media-image"
                      src={item.kind === 'video' ? item.poster : item.src}
                      alt=""
                    />
                  ) : null}
                  {item.kind === 'video' ? (
                    <Play className="weq-record-media-play" size={16} aria-hidden />
                  ) : null}
                </button>
              );
            }
            return (
              <div
                {...contextProps(message)}
                key={key}
                className="weq-record-media-thumbnail is-native"
                data-message-media-key={messageMediaKey(element)}
                role="group"
                tabIndex={0}
                aria-label={type === 'emoji' ? '表情' : '图片'}
              >
                <MediaBrowseContext.Provider value>
                  <QqMessageContent
                    elements={[element]}
                    msgId={message.msgId}
                    msgSeq={message.msgSeq}
                    sendTimeMs={Number(message.sendTime) * 1000}
                  />
                </MediaBrowseContext.Provider>
              </div>
            );
          });
        })}
      </div>
    </Fragment>
  ));
}
