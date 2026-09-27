/**
 * QQ 闪传（fileset）消息的识别与对账键。
 *
 * 同一条闪传消息在不同客户端上是**两种落库形态**（真机实测，见 send-flash 那条注释）：
 *
 *   1. **markdown 卡片**（`40800.45002 = 14`）：`flashTransferInfo.fileSetId` 就是
 *      fileset uuid，与发送时 0x93cf 回执给的 `filesetUuid` 同一个值 —— Windows 这类
 *      支持 fileset 的客户端走这条；
 *   2. **纯文本 fallback**（`45002 = 1`）：服务端按收端能力下发固定话术
 *      「…通过QQ闪传发送文件给你，请打开链接查看：https://qfile.qq.com/q/<code>…」
 *      —— Linux / 鸿蒙等客户端走这条，**整条消息里没有任何 uuid**（全库 0 条带
 *      `flashTransferInfo` 的闪传消息）。
 *
 * 所以对账键必须有两个，命中任一即认为「这条真消息就是我们发出去的那条闪传」：
 *
 *   - `flash:set:<uuid>`  —— 发送端从 0x93cf 回执的 `filesetUuid` 得到；
 *   - `flash:code:<code>` —— 发送端从同一个回执的 `shareUrl`（`qfile.qq.com/q/<code>`）
 *     得到；实测这颗 code 与卡片里的 uuid 指向同一个 fileset（0x93d3 互换验证过）。
 *
 * 两侧统一归一化：uuid `lower + 去 -`（真机上 `fileset_id=` 两种写法都出现过），
 * share code 只做小写化，仅用于**比较**口径。
 *
 * 注意：0x93d7 的回执只有目标回显（14 字节），cid / seq / msgId 在发送那一刻全都
 * 拿不到 —— 上面这两个键是仅有的「发送前已知、真消息里也存在」的句柄。
 */

/** 一条消息元素的最小形状（`qqElements` / wire 元素同形）。 */
export interface FlashElement {
  type?: string;
  data?: Record<string, unknown>;
}

/** 服务端下发的固定话术（版本措辞略有出入，只锁最有辨识度的那句）。 */
const FLASH_FALLBACK_RE = /通过QQ闪传(?:发送|分享)文件给你/;

/** 分享链接 `https://qfile.qq.com/q/<code>`。 */
const FLASH_SHARE_LINK_RE = /https?:\/\/qfile\.qq\.com\/q\/([A-Za-z0-9_-]+)/;

/** fileset uuid 归一化：忽略大小写与连字符。 */
export function normalizeFilesetId(id: string): string {
  return id.trim().toLowerCase().replace(/-/g, '');
}

/**
 * 从 `flashTransferInfo` / `markdownContent` 里取 fileset uuid。
 *
 * 两处本应是同一个值，但真机上见过「48708 里缺省、只有 route 带 id」的形态，
 * 所以两边都看（`filesetid 不是必需，缺省不输出`）。
 */
export function flashFilesetIdOf(info: unknown, markdownContent: string): string {
  const direct = (info as { fileSetId?: unknown } | null | undefined)?.fileSetId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  // markdownContent 是 `…&json=<url-encoded JSON>`，route 里的 `fileset_id=` 可能被
  // 编码成 `%3D`（两种写法真机都见过），所以两种都认。
  const match = markdownContent.match(/fileset_id(?:=|%3D|%3d)([A-Za-z0-9-]+)/);
  return match?.[1] ?? '';
}

/** 一条消息元素 → fileset uuid（非闪传卡片给 ''）。 */
export function flashFilesetIdOfElement(element: unknown): string {
  const el = element as FlashElement | null | undefined;
  if (el?.type !== 'markdown') return '';
  const info = el.data?.flashTransferInfo;
  if (!info || typeof info !== 'object') return '';
  return flashFilesetIdOf(info, String(el.data?.markdownContent ?? ''));
}

/**
 * 文本 fallback（Linux / 鸿蒙形态）里的 share code。
 *
 * **先按固定话术匹配，命中才去抠链接** —— 绝不逐条验证消息里的链接：既避免把一条
 * 恰好带 qfile 链接的普通消息误判成闪传，也不引入任何额外网络请求。
 */
export function flashFallbackShareCode(elements: unknown[]): string {
  let text = '';
  for (const element of elements) {
    const el = element as FlashElement | null | undefined;
    if (el?.type !== 'text') continue;
    text += String(el.data?.textContent ?? '');
  }
  if (!text || !FLASH_FALLBACK_RE.test(text)) return '';
  return text.match(FLASH_SHARE_LINK_RE)?.[1] ?? '';
}

/** 从分享链接里取 share code（不是分享链接就给 ''）。 */
export function flashShareCodeOf(shareUrl: string): string {
  return shareUrl.match(FLASH_SHARE_LINK_RE)?.[1] ?? '';
}

/** fileset uuid → 对账签名。 */
export function flashFilesetSignature(filesetId: string): string {
  const norm = normalizeFilesetId(filesetId);
  return norm ? `flash:set:${norm}` : '';
}

/** share code → 对账签名。 */
export function flashCodeSignature(code: string): string {
  const norm = code.trim().toLowerCase();
  return norm ? `flash:code:${norm}` : '';
}

/**
 * 发送端：0x93cf 回执的 `filesetUuid` + `shareUrl` → 对账签名。
 *
 * 两个都给 —— 真消息是哪种形态都能命中；缺哪个就少一个键（uuid 一定在，shareUrl
 * 理论上可能有空）。
 */
export function flashSendSignatures(filesetUuid: string, shareUrl: string): string[] {
  return [
    flashFilesetSignature(filesetUuid),
    flashCodeSignature(flashShareCodeOf(shareUrl)),
  ].filter((signature) => signature !== '');
}

/**
 * 一条真消息的元素 → 闪传对账签名：markdown 卡片给 `flash:set:`，文本 fallback 给
 * `flash:code:`。都不是闪传就给空数组。
 */
export function flashWireSignatures(elements: unknown[]): string[] {
  const out: string[] = [];
  for (const element of elements) {
    const signature = flashFilesetSignature(flashFilesetIdOfElement(element));
    if (signature) out.push(signature);
  }
  const code = flashFallbackShareCode(elements);
  if (code) out.push(flashCodeSignature(code));
  return out;
}
