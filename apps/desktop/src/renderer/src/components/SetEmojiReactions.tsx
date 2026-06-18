/**
 * Renders a group message's sticker reactions (贴表情, SQL column 40062).
 *
 * Layout: a row sitting directly below the original message. Each reaction is a
 * small `FaceEmoji` (the `emojiId` is a QQ faceId) followed by its set count.
 * Reactions wrap to a new row after 7 emoji kinds. A reaction the logged-in
 * account set itself (`isSelfSet`) is highlighted.
 */

import type { SetEmojiItem } from '@weq/codec';
import { FaceEmoji } from './FaceEmoji';
import { cn } from '@renderer/lib/utils';

/** Reaction emoji box size; smaller than an inline face. */
const REACTION_FACE_SIZE = 18;

export function SetEmojiReactions({ list }: { list?: SetEmojiItem[] }) {
  if (!list || list.length === 0) return null;

  return (
    <div className="msg-reactions">
      {list.map((item) => {
        const faceId = Number(item.emojiId);
        return (
          <span
            key={item.emojiId}
            className={cn('msg-reaction', item.isSelfSet && 'is-self')}
            title={item.emojiId}
          >
            {Number.isInteger(faceId) ? (
              <FaceEmoji element={{ faceId }} size={REACTION_FACE_SIZE} />
            ) : (
              <span className="msg-reaction-raw">{item.emojiId}</span>
            )}
            <span className="msg-reaction-count">{item.setNum}</span>
          </span>
        );
      })}
    </div>
  );
}
