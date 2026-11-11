import {
  systemFaceItem,
  unicodeFaceItem,
  type EmojiItem,
} from '../im-template/template/emojiPacks';

export type ReactionItem = { code: string; title: string; item: EmojiItem };
export type FaceGroup = {
  unicode?: boolean;
  items: { id: string | number; desc: string; glyph?: string }[];
};

export function reactionItems(groups: readonly FaceGroup[]): ReactionItem[] {
  return groups.flatMap((group) =>
    group.items.flatMap((face) => {
      if (!group.unicode)
        return [
          { code: String(face.id), title: face.desc, item: systemFaceItem(face.id, face.desc) },
        ];
      const glyph = face.glyph || String(face.id);
      const point = glyph.codePointAt(0);
      return point === undefined
        ? []
        : [{ code: String(point), title: face.desc, item: unicodeFaceItem(glyph, face.desc) }];
    }),
  );
}

// 使用现有系统表情资源；目录尚未返回时也能立即绘制默认回应。
export const DEFAULT_REACTIONS: ReactionItem[] = [
  ['76', '赞'],
  ['66', '爱心'],
  ['14', '微笑'],
  ['9', '大哭'],
  ['182', '笑哭'],
  ['49', '抱抱'],
].map(([code, title]) => ({ code: code!, title: title!, item: systemFaceItem(code!, title!) }));

export function quickReactions(
  recent: readonly string[],
  catalog: readonly ReactionItem[],
): ReactionItem[] {
  const items = new Map([...DEFAULT_REACTIONS, ...catalog].map((item) => [item.code, item]));
  return [...new Set([...recent, ...DEFAULT_REACTIONS.map((item) => item.code)])]
    .flatMap((code) => (items.has(code) ? [items.get(code)!] : []))
    .slice(0, 6);
}
