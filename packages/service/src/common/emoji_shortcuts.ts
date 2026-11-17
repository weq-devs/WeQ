import nativeShortcuts from '../../../../resources/emoji/shortcuts.json';

// QQNT 7.0.3-54395 r_90099 原始映射；未定义的表情不能按拼音补造别名。

export interface SystemEmojiShortcut {
  id: string;
  desc: string;
  /** QQNT 原表中的别名及顺序；没有定义时保持空数组。 */
  shortcuts: string[];
}

export function buildSystemEmojiShortcuts(
  faces: readonly { id: string; desc: string }[],
): SystemEmojiShortcut[] {
  const seen = new Set<string>();
  const table: Readonly<Record<string, readonly string[]>> = nativeShortcuts;
  return faces.flatMap(({ id, desc }) => {
    if (!/^\d+$/u.test(id) || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        desc,
        shortcuts: [...(table[id] ?? [])],
      },
    ];
  });
}
