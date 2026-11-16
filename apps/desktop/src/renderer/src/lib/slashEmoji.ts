export interface SlashEmojiFace {
  id: string;
  desc: string;
  shortcuts?: readonly string[];
}
export interface SlashEmojiTrigger {
  start: number;
  end: number;
  query: string;
}

export function slashEmojiTrigger(before: string): SlashEmojiTrigger | null {
  const match = /\/([^/\s\r\n]{0,64})$/u.exec(before);
  if (!match) return null;
  const word =
    before
      .slice(0, match.index)
      .split(/\s|\]\]/u)
      .at(-1) ?? '';
  if (/[/:\\]/u.test(word) || /(?:\.[a-z\d-]+|^~|^\.{1,2})$/iu.test(word)) return null;
  return { start: match.index, end: before.length, query: match[1] ?? '' };
}

function searchName(value: string) {
  return value
    .replace(/^\//u, '')
    .replace(/^\[([^\]]+)\]$/u, '$1')
    .trim()
    .toLowerCase();
}
export function searchSlashEmojis(
  faces: readonly SlashEmojiFace[],
  recent: readonly { id: string; usedAt: number }[],
  query: string,
): SlashEmojiFace[] {
  const keyword = searchName(query);
  const used = new Map(recent.map((item) => [item.id, item.usedAt]));
  const seen = new Set<string>();
  return faces
    .flatMap((face, index) => {
      if (seen.has(face.id) || !/^\d+$/u.test(face.id)) return [];
      seen.add(face.id);
      const keys = [...(face.shortcuts ?? []), face.desc].map(searchName);
      const rank = !keyword
        ? 0
        : Math.min(
            ...keys.map((name) =>
              name === keyword
                ? 0
                : name.startsWith(keyword)
                  ? 1
                  : name.includes(keyword)
                    ? 2
                    : Infinity,
            ),
          );
      return Number.isFinite(rank) ? [{ face, rank, usedAt: used.get(face.id) ?? 0, index }] : [];
    })
    .sort((a, b) => a.rank - b.rank || b.usedAt - a.usedAt || a.index - b.index)
    .map((item) => item.face);
}
