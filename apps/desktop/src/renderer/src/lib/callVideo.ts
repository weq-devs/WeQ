/**
 * 通话视频解码的**纯逻辑**：把主进程推来的 Annex B 裸流整成解码器能吃的块。
 *
 * 从 `hooks/useCallVideo.ts` 抽出来是为了能写单测 —— WebCodecs 的 `VideoDecoder`
 * 在 vitest（Node）里不存在，但「参数集怎么摆」这部分恰恰是踩坑最多的地方。
 * 这里定下的结论全部来自 2026-10-25 的真实抓包 + Electron 44 实测：
 *
 * | 配置 | 结果 |
 * | --- | --- |
 * | `hev1`/`hvc1`，**不带** `description`，参数集内联 | ✅ 正常解 |
 * | 带 `description`（Annex B 形态的参数集） | ❌ `isConfigSupported` 直接 false |
 * | 带 `description`（规范的 hvcC） | ❌ 能配置成功，首帧就 `Decoder error` |
 *
 * 所以：**参数集一律内联，`VideoDecoderConfig.description` 永远不传**。
 */

/**
 * ⚠️ **不要**从 `@weq/protocol` 值导入 `splitHevcNals`。
 *
 * protocol 的主入口会 `export * from './call'`，而 `call/signaling.ts` 一路引到
 * `oidb/invoke.ts` → `transport.ts` → `redbag/sign.ts`，那里用了 `node:crypto`。
 * renderer 的 vite 构建会把它判成 `__vite-browser-external`，直接构建失败：
 *
 * ```
 * "createHash" is not exported by "__vite-browser-external:node:crypto"
 * ```
 *
 * 所以下面这份 NAL 切分是**有意重复**的：它只认起始码和 NAL 类型，二十来行，
 * 没有依赖。协议层那份在服务端继续用（`packages/protocol/src/call/video.ts`）。
 */

/** 一个 NAL 单元。 */
interface HevcNal {
  /** HEVC NAL 类型：`(byte >> 1) & 0x3f`。 */
  type: number;
  /** 不含起始码的 NAL 内容（从 2 字节 NAL 头开始）。 */
  data: Uint8Array;
}

/** 把一个 Annex B 裸流切成 NAL 单元。 */
export function splitHevcNals(data: Uint8Array): HevcNal[] {
  const nals: HevcNal[] = [];
  let i = 0;
  let start = -1;
  while (i < data.length) {
    const four =
      i + 4 <= data.length &&
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1;
    const three =
      !four && i + 3 <= data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1;
    if (four || three) {
      if (start >= 0) {
        const body = data.subarray(start, i);
        if (body.length >= 2) nals.push({ type: (body[0]! >> 1) & 0x3f, data: body });
      }
      start = i + (four ? 4 : 3);
      i = start;
      continue;
    }
    i++;
  }
  if (start >= 0 && start < data.length) {
    const body = data.subarray(start);
    if (body.length >= 2) nals.push({ type: (body[0]! >> 1) & 0x3f, data: body });
  }
  return nals;
}

/** 一个待解码的 access unit。 */
export interface HevcAccessUnit {
  /** 可直接喂给 `EncodedVideoChunk` 的 Annex B 数据。 */
  data: Uint8Array | null;
  /** 这一帧里含 IRAP（IDR/CRA/BLA），可以起解。 */
  keyframe: boolean;
  /** 这一帧自带的参数集（VPS/SPS/PPS），没有则为空。 */
  params: Uint8Array[];
}

/** 把任意形态的字节统一成 `Uint8Array`。 */
export function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  // Node Buffer 的 JSON 形态（tRPC 的 subscription 走 JSON 序列化时会出现）
  const json = value as { type?: string; data?: number[] } | null;
  if (json && json.type === 'Buffer' && Array.isArray(json.data)) {
    return Uint8Array.from(json.data);
  }
  // 普通对象 {0:..,1:..,length:n}。字符串也有 `length`，必须先排除 —— 否则
  // 一段文本会被当成字节数组读出一串 NaN → 0。
  if (typeof value === 'string') return null;
  if (json && typeof (json as { length?: unknown }).length === 'number') {
    const len = (json as { length: number }).length;
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = (json as unknown as Record<number, number>)[i] ?? 0;
    return out;
  }
  return null;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Annex B 起始码 + NAL 拼回去。 */
export function annexB(nals: readonly Uint8Array[]): Uint8Array {
  return concatBytes(nals.flatMap((nal) => [new Uint8Array([0, 0, 0, 1]), nal]));
}

/**
 * 把主进程推来的裸流规整成一个 access unit。
 *
 * 实测对端的首帧就是 `VPS + SPS + PPS + IDR` 四个 NAL 拼在一起 —— 正好是一个完整
 * AU，**原样按 Annex B 送进去即可**，既不要剥掉参数集，也不要塞进 `description`。
 */
export function toAccessUnit(input: unknown): HevcAccessUnit {
  const nals = splitHevcNals(toBytes(input) ?? new Uint8Array(0));
  if (nals.length === 0) return { data: null, keyframe: false, params: [] };

  const isParam = (t: number) => t === 32 || t === 33 || t === 34;
  return {
    data: annexB(nals.map((nal) => nal.data)),
    keyframe: nals.some((nal) => nal.type >= 16 && nal.type <= 21),
    params: nals.filter((nal) => isParam(nal.type)).map((nal) => nal.data),
  };
}

/**
 * 判断这一帧能否喂给解码器：帧序号必须与上一帧连续，或者本帧是关键帧。
 *
 * ## 为什么必须做这个检查
 *
 * 2026-10-26 Windows 真机复现：渲染层订阅比主进程收帧晚约 1.9 秒。订阅时补发
 * 缓存的关键帧（帧 0），但紧接着喂的是**实时帧**（帧 29），中间 1~28 全部缺失。
 *
 * HEVC 的 P 帧依赖前序参考帧。Chromium 硬解在拒绝这些「无参考帧」的 delta 后
 * **内部状态被污染**，继续输出错乱的 YUV —— 实测整屏纯绿（中心 RGB `[0,88,0]`，
 * R/B 恒为 0），直到下一个关键帧（帧 257，约 15 秒后）才重新同步。
 *
 * 离线复现（`tmp/verify_fix.cjs`，同一份对端码流）：
 *
 * | 喂入方式 | 绿帧数 |
 * | --- | --- |
 * | 连续喂 0,1,2,… | 0 |
 * | 跳帧喂 0,29,30,…（修复前） | 228（#1..#228） |
 * | 跳帧喂 + 本检查（修复后） | 0（丢弃 228 帧，等关键帧） |
 *
 * 代价是画面「冻」到下一个关键帧才动 —— 好过整屏绿 15 秒。
 *
 * @param previous 上一个**喂进解码器**的帧序号；null 表示还没有（刚起解）
 * @param current 本帧的 16 位帧序号
 * @param keyframe 本帧是否含 IRAP
 */
export function acceptsFrame(previous: number | null, current: number, keyframe: boolean): boolean {
  // 关键帧永远可以起解 —— 它是参考链的起点。
  if (keyframe) return true;
  // 还没有基准：交给调用方的「未配置」逻辑处理。
  if (previous === null) return true;
  // 16 位序号会回绕（65535 → 0）。先按模取「前进了多少」，再判断是否为 1。
  return (current - previous + 65536) % 65536 === 1;
}

// ─────────────────────── 画面旋转（手机竖屏） ───────────────────────

/**
 * 对端画面的旋转角度，**由用户手动切换**，不做自动判断。
 *
 * ## 为什么不自动判
 *
 * 2026-10-27 / 10-28 两次真机抓包对照，结论是**没有可靠信号**：
 *
 * | 线索 | 实测 |
 * | --- | --- |
 * | SPS 的 VUI 旋转字段 | 没有，SPS 里就是 640×360 |
 * | SEI 方向信息 | 全流一条 SEI NAL 都没有 |
 * | 视频包扩展段 | 恒为 `03 03 00`，不含方向 |
 * | `bt=77` 的 `f14/f15` | 与画面朝向无关 |
 * | 内容黑边 / 宽高比 | 手机竖屏画面**铺满整帧**（实测内容 640×318，比例 2.01，无黑边），看着就是个横屏 |
 *
 * 也就是说解码出来的帧从数据上看与横屏通话**完全一致**，任何自动判据都只能靠猜
 * （比如「检测画面里有没有横向文字」），误判时用户看到的是画面自己乱转 —— 比多
 * 点一下按钮糟得多。所以只给按钮。
 *
 * 顺时针 90° = 逆时针 270°。要反过来就把这一处改成 270。
 */
export const PEER_ROTATE: 0 | 90 | 270 = 90;

/** 点一下旋转按钮后的下一个角度：0 → 90 → 270 → 0。 */
export function nextRotation(current: 0 | 90 | 270): 0 | 90 | 270 {
  if (current === 0) return 90;
  if (current === 90) return 270;
  return 0;
}

/**
 * 给「新建 / 重建的解码器」准备首个 chunk 的载荷。
 *
 * 解码器 `close()` 重建后，**必须**在下一个关键帧前面补回参数集：实测不补 ->
 * 那个只含 IDR/CRA 的关键帧会让 `decode()` 一直抛
 * `A key frame is required after configure()`，画面永久黑掉（0 帧）；补上 -> 正常
 * 解出全部帧。
 *
 * @param au 当前帧
 * @param cachedParams 之前存下的参数集（`au.params` 为空时用它）
 * @param fresh 解码器是否是刚建 / 刚重建的
 */
export function payloadForDecoder(
  au: Pick<HevcAccessUnit, 'data' | 'params'>,
  cachedParams: readonly Uint8Array[],
  fresh: boolean,
): Uint8Array | null {
  if (!au.data) return null;
  if (!fresh || au.params.length > 0 || cachedParams.length === 0) return au.data;
  return concatBytes([annexB(cachedParams), au.data]);
}
