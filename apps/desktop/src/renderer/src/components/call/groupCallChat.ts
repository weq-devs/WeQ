interface GroupCallFace {
  id: number;
  token: string;
  sticker: boolean;
}

/** 同名表情优先使用内联小黄脸。长名字先匹配，保留表情后面紧接的正文。 */
export function groupCallFaces(
  entries: ReadonlyArray<{ id: number; desc: string; sticker: boolean }>,
): GroupCallFace[] {
  return entries
    .filter(({ desc }) => desc.startsWith('/') && desc.length > 1)
    .map(({ id, desc, sticker }) => ({ id, token: desc, sticker }))
    .sort(
      (a, b) =>
        b.token.length - a.token.length || Number(a.sticker) - Number(b.sticker) || a.id - b.id,
    );
}

interface ChatPart {
  offset: number;
  text: string;
  faceId?: number;
}

/** 0x14 标记紧随其后的表情名。同一字段可以交替包含普通文字和表情。 */
export function splitGroupCallChat(text: string, faces: readonly GroupCallFace[]): ChatPart[] {
  const [plain, ...marked] = text.split('\x14');
  const parts: ChatPart[] = plain ? [{ offset: 0, text: plain }] : [];
  let offset = plain?.length ?? 0;
  for (const chunk of marked) {
    offset += 1;
    const face = faces.find(({ token }) => chunk.startsWith(token));
    const length = face?.token.length ?? 0;
    if (face) parts.push({ offset, text: face.token, faceId: face.id });
    if (chunk.length > length) parts.push({ offset: offset + length, text: chunk.slice(length) });
    offset += chunk.length;
  }
  return parts;
}
