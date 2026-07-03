/**
 * 出站归一化：AgentRuntime 产出的一条 renderedTurn → 一条消息的 OneBot 段数组。
 *
 * renderedTurn 三种形态（与桌面 ChatBubble 消费的内部标记一致）：
 * - 纯文本（可含系统表情 /捂脸）→ text 段（TODO M2: 把 /捂脸 拆成独立 face 段）
 * - `[[sticker:md5]]` → image 段（读导出资产 stickers/<md5>.png）
 * - `[[voice:id]]`   → record 段（读导出资产 agentvoice/<id>）
 *
 * 扩展轴②：未来引擎产出新 action（at/reply/poke...）时，在这里加一条编码分支即可。
 */
import { readFileSync } from 'node:fs';
import type { OneBotSegment } from '../adapter/types';
import { splitSystemFaces } from './qq_faces';

const STICKER_RE = /^\[\[sticker:([0-9a-fA-F]+)\]\]$/;
const VOICE_RE = /^\[\[voice:([0-9a-zA-Z._-]+)\]\]$/;

/** 资产路径解析器：把 sticker md5 / voice id 映射成本地文件绝对路径（找不到返回 null）。 */
export interface AssetResolver {
  stickerPath(md5: string): string | null;
  voicePath(id: string): string | null;
}

/** 本地文件 → OneBot file 字段（base64://，最通用，不要求 napcat 能访问 bot 的文件系统）。 */
function fileToBase64Uri(path: string): string {
  return `base64://${readFileSync(path).toString('base64')}`;
}

/**
 * 编码一条 renderedTurn 为段数组。返回 null 表示这条不发（如表情图/语音文件缺失）。
 */
export function encodeTurn(turn: string, assets: AssetResolver): OneBotSegment[] | null {
  const sticker = turn.match(STICKER_RE);
  if (sticker) {
    const path = assets.stickerPath(sticker[1]!);
    if (!path) return null;
    return [{ type: 'image', data: { file: fileToBase64Uri(path) } }];
  }
  const voice = turn.match(VOICE_RE);
  if (voice) {
    const path = assets.voicePath(voice[1]!);
    if (!path) return null;
    return [{ type: 'record', data: { file: fileToBase64Uri(path) } }];
  }
  const text = turn.trim();
  if (!text) return null;
  // 纯文本：把系统表情 /捂脸 拆成 face 段，其余留 text 段，QQ 才渲染成表情图。
  return splitSystemFaces(text);
}
