/**
 * Full 收藏 detail payloads stored in `content_list_info_table` after the
 * official QQ client opens an item.
 *
 * Each database column is its own envelope (`180701` … `180708`). The useful
 * content messages continue the same global-tag numbering used by summaries:
 * text content starts at 180800, audio at 181100, and rich media at 181500.
 */

import { ProtoField, ScalarType } from '../../core';
import { FileInfo, PicInfo } from './common';

export const TextContent = {
  data: ProtoField(180800, ScalarType.STRING, { optional: true }),
  hasEmoji: ProtoField(180801, ScalarType.BOOL, { optional: true }),
};

export const AudioContent = {
  data: ProtoField(181100, ScalarType.STRING, { optional: true }),
};

export const RichMediaContent = {
  rawData: ProtoField(181500, ScalarType.STRING, { optional: true }),
  bizDataList: ProtoField(181501, ScalarType.STRING, { optional: true, repeat: true }),
  picList: ProtoField(181502, () => PicInfo, { optional: true, repeat: true }),
  fileList: ProtoField(181503, () => FileInfo, { optional: true, repeat: true }),
};

export const CollectionTextContentColumn = {
  content: ProtoField(180701, () => TextContent, { optional: true }),
};

export const CollectionAudioContentColumn = {
  content: ProtoField(180704, () => AudioContent, { optional: true }),
};

export const CollectionRichMediaContentColumn = {
  content: ProtoField(180708, () => RichMediaContent, { optional: true }),
};
