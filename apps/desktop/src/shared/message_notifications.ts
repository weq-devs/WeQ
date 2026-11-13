export interface IncomingNoticeMessage {
  kind: 'c2c' | 'group';
  conv: string;
  msgId: string;
  msgSeq: string;
  senderUid: string;
  senderUin: string;
  sendTime: string;
  source?: string;
}
/** 使用与本地实时未读一致的时间窗口；旧导入和自身发送不产生普通通知。 */
export function ordinaryNoticeEligible(
  message: IncomingNoticeMessage,
  options: {
    selfUin: string;
    selfUid?: string;
    openedAt: number;
    observedAt: number;
    freshSeconds: number;
    muted: boolean;
    reading: boolean;
  },
) {
  const time = Number(message.sendTime);
  return Boolean(
    message.conv &&
      message.msgId &&
      /^[1-9]\d*$/.test(message.msgSeq) &&
      message.source !== 'roaming' &&
      !options.muted &&
      !options.reading &&
      message.senderUin !== options.selfUin &&
      (!options.selfUid || message.senderUid !== options.selfUid) &&
      (message.kind === 'group' || message.senderUid === message.conv) &&
      Number.isFinite(time) &&
      time >= Math.max(options.openedAt, options.observedAt) - options.freshSeconds &&
      time <= options.observedAt + options.freshSeconds,
  );
}

/** Windows 任务栏使用平台原生像素格式；从 nativeImage 取得颜色像素后绘制数字角标。 */
export function applicationBadgeBitmap(count: number, red: Uint8Array, white: Uint8Array) {
  const size = 16;
  const bytes = new Uint8Array(size * size * 4);
  const pixel = (x: number, y: number, color: Uint8Array) =>
    bytes.set(color.subarray(0, 4), (y * size + x) * 4);
  if (count <= 0) return bytes;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 56) pixel(x, y, red);
  const glyphs: Record<string, string[]> = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
    '+': ['000', '010', '111', '010', '000'],
  };
  const label = count > 99 ? '99+' : String(Math.floor(count));
  const start = Math.floor((size - (label.length * 4 - 1)) / 2);
  [...label].forEach((character, index) => {
    glyphs[character]?.forEach((row, y) => {
      [...row].forEach((value, x) => {
        if (value === '1') pixel(start + index * 4 + x, y + 5, white);
      });
    });
  });
  return bytes;
}
