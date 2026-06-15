import { ProtoField, ScalarType } from '../../core';

export const EmojiSticker = {
  emojiId: ProtoField(48301, ScalarType.STRING, { optional: true }),
  setFlag: ProtoField(48302, ScalarType.INT32, { optional: true }),
  emojiNum: ProtoField(48303, ScalarType.INT32, { optional: true }),
  isSelfSet: ProtoField(48304, ScalarType.BOOL, { optional: true }),
};

export const MsgEmoji = {
  stickers: ProtoField(40062, () => EmojiSticker, { optional: true, repeat: true }),
};
