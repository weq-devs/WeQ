/**
 * QQ 数据包长度前缀的自动识别。
 *
 * 抓包 / 内存里拿到的 protobuf 或 JCE 字节经常外面套了一层「长度前缀」，
 * 例如 `00 00 00 D5 0A 08 …` —— 前 4 字节大端就是整包长度（0xD5 = 213，
 * 含前缀自身）。直接把这种字节喂给 protobuf/JCE 解析器会在开头几个字节上
 * 解出让游标跑偏的假字段，最后整条消息解析失败。
 *
 * 这里**不硬编码「去掉前 4 字节」**：而是枚举常见前缀宽度（4 / 2 / 1 字节）
 * 与字节序（大端 / 小端），只有当读出的数值**恰好等于**整包长度（含前缀）
 * 或**恰好等于**负载长度（不含前缀）时才认为它是一个长度前缀。值对不上就
 * 不认，避免把真实字段当成前缀削掉。
 *
 * 只做识别，不负责解析；调用方在识别出的 `body` 上再试真正的解析器，只有
 * 解析成功才说明这个前缀认得对（见 `tryDecodeAfterLengthPrefix`）。
 */

/** 一个被识别出来的长度前缀。 */
export interface LengthPrefix {
  /** 前缀宽度（字节）。 */
  width: number;
  /** 字节序：大端 / 小端。 */
  endian: 'be' | 'le';
  /** 前缀声明的长度值。 */
  value: number;
  /** 该值的语义：整包长度（含前缀）还是负载长度（不含前缀）。 */
  declared: 'total' | 'payload';
  /** 前缀原始字节。 */
  bytes: Uint8Array;
  /** 去掉前缀后的负载字节。 */
  body: Uint8Array;
}

/** 按宽度与字节序读一个无符号整数（不依赖 DataView，兼容任意长度的切片）。 */
function readUInt(buf: Uint8Array, width: number, endian: 'be' | 'le'): number {
  let value = 0;
  if (endian === 'be') {
    for (let i = 0; i < width; i += 1) value = value * 256 + buf[i]!;
  } else {
    for (let i = width - 1; i >= 0; i -= 1) value = value * 256 + buf[i]!;
  }
  return value;
}

/**
 * 枚举全部「数值自洽」的长度前缀候选，按可信度排序：
 *   4 字节大端 → 4 字节小端 → 2 字节大端 → 2 字节小端 → 1 字节。
 *
 * 「自洽」= 读出的值 == 整包长度，或 == 负载长度（整包长度 − 前缀宽度）。
 * 例如示例包 213 字节、前缀 `00 00 00 D5`：0xD5 = 213 = 整包长度 → 命中
 * `declared: 'total'`。短包上 2 / 1 字节前缀也能被认出来，同样是靠数值自洽。
 */
export function detectLengthPrefixes(buf: Uint8Array): LengthPrefix[] {
  const out: LengthPrefix[] = [];
  const widths = [4, 2, 1] as const;
  for (const width of widths) {
    if (buf.length <= width) continue;
    const endians: Array<'be' | 'le'> = width === 1 ? ['be'] : ['be', 'le'];
    for (const endian of endians) {
      const value = readUInt(buf, width, endian);
      const declared: LengthPrefix['declared'] | null =
        value === buf.length ? 'total' : value === buf.length - width ? 'payload' : null;
      if (declared === null || value === 0) continue;
      out.push({
        width,
        endian,
        value,
        declared,
        bytes: buf.slice(0, width),
        body: buf.slice(width),
      });
    }
  }
  return out;
}

/** 取第一个（最可信的）长度前缀候选；没有自洽的候选时返回 null。 */
export function detectLengthPrefix(buf: Uint8Array): LengthPrefix | null {
  return detectLengthPrefixes(buf)[0] ?? null;
}

/** 前缀的简短人类可读描述，UI / 工具输出共用。 */
export function describeLengthPrefix(prefix: LengthPrefix): string {
  const endian = prefix.endian === 'be' ? '大端' : '小端';
  const declared = prefix.declared === 'total' ? '整包长度' : '负载长度';
  return `${prefix.width} 字节${endian}长度前缀（值 ${prefix.value} = ${declared}），已自动剥离`;
}
