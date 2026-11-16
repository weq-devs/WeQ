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
export interface SlashEmojiMatch extends SlashEmojiFace {
  code: string;
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
const codeOrder = new Intl.Collator('zh-CN');

export function searchSlashEmojis(
  faces: readonly SlashEmojiFace[],
  query: string,
): SlashEmojiMatch[] {
  const keyword = searchName(query);
  const seen = new Set<string>();
  return faces
    .flatMap((face) => {
      if (seen.has(face.id) || !/^\d+$/u.test(face.id)) return [];
      seen.add(face.id);
      const keys =
        !keyword && face.shortcuts?.length
          ? face.shortcuts
          : [...(face.shortcuts ?? []), face.desc];
      const code = keys
        .map(searchName)
        .filter((name) => name.length > 0 && name.startsWith(keyword))
        .sort(codeOrder.compare)[0];
      return code ? [{ ...face, code }] : [];
    })
    .sort((a, b) => codeOrder.compare(a.code, b.code) || codeOrder.compare(a.id, b.id));
}
