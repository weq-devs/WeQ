/**
 * 会话列表「最新消息」预览：把 `recent_contact_v3_table` 的 40051 预览元素解析
 * 成可渲染节点（文本 + 表情）。
 *
 * QQ 把整条消息冗余存进了预览列 —— 灰条的 gtip XML / tipJson、群提示的结构化
 * 字段、表情消息的 textContent + faceId 全都在里面，与消息表 40800 的内容一字
 * 不差。所以预览是纯本地计算，不需要回查消息表、不产生任何异步请求。
 *
 * 此前只读 `displayText` 单个字段，于是丢了两类信息：表情消息只显示 "/斜眼笑"
 * 而丢掉正文 "看出来了"；灰条根本没有 displayText，退化成按 kind 直译的死标签
 * ——subType=12 在 codec 里叫 grayTipXml（XML 类灰条的统称），于是「回应了你的
 * 消息」被显示成了别的东西。
 */

import { DOMParser, type Node } from '@xmldom/xmldom';

export type PreviewNode =
  | { t: 'text'; text: string }
  /** `label` 缺失时由渲染层查 emoji.db 补全（gtip XML 的 <face> 只带 id）。 */
  | { t: 'face'; faceId: number; label?: string };

/** 无有效文本的媒体类元素的固定括号标签。 */
const KIND_LABEL: Record<string, string> = {
  pic: '[图片]',
  file: '[文件]',
  video: '[视频]',
  ptt: '[语音]',
  face: '[表情]',
  mface: '[贴纸]',
  ark: '[卡片消息]',
  markdown: '[卡片消息]',
  multiMsg: '[合并转发]',
  call: '[通话]',
  wallet: '[红包]',
  onlineFile: '[在线文件]',
  onlineFolder: '[在线文件夹]',
  emojiBounce: '[表情互动]',
  qqDynamic: '[QQ动态]',
  reply: '[回复]',
  shareLocation: '[位置共享]',
  grayTipTempSession: '[临时会话]',
};

type Rec = Record<string, unknown>;

export function previewNodes(preview: unknown): PreviewNode[] {
  if (!preview || typeof preview !== 'object') return [];
  const el = preview as Rec;
  const kind = str(el.kind);

  // 表情消息：QQ 把正文塞进 textContent、表情单独放 faceId，displayText 只有
  // 表情名。两部分都要，顺序与消息体一致（正文在前、表情在后）。
  if (kind === 'face') {
    const nodes: PreviewNode[] = [];
    const body = str(el.textContent).trim();
    if (body) nodes.push({ t: 'text', text: body });
    const faceId = num(el.faceId);
    if (faceId > 0) nodes.push({ t: 'face', faceId, label: str(el.displayText) || undefined });
    return nodes.length ? nodes : [{ t: 'text', text: '[表情]' }];
  }

  // 灰条优先读自带的 payload —— 它比 displayText 完整，且灰条常常根本没有
  // displayText（全库 400 条会话里 grayTipGroup/Poke/Xml 无一例外）。
  if (kind.startsWith('grayTip')) {
    const nodes = grayTipNodes(el, kind);
    if (nodes?.length) return nodes;
  }

  // 纯文本元素：displayText 为空时用正文兜底。QQ 的机器人 markdown 消息在 40051
  // 里存成 [markdown, text] 两个元素，TEXT 元素带 textContent 但 49093 是空的。
  if (kind === 'text') {
    const text = str(el.textContent).trim();
    if (hasVisibleText(text)) return [{ t: 'text', text }];
  }

  // 机器人 markdown：49093 只有 "[Markdown]" 标签，正文在 49099（次选 48705 摘
  // 要 / 45101 正文），列表里应该显示正文而不是标签。
  if (kind === 'markdown') {
    const content =
      str(el.markdownContent49099).trim() ||
      str(el.markdownTextSummary).trim() ||
      str(el.textContent).trim();
    if (hasVisibleText(content)) return [{ t: 'text', text: content }];
  }

  const display = str(el.displayText).trim();
  if (hasVisibleText(display)) return [{ t: 'text', text: display }];

  const label = KIND_LABEL[kind];
  return label ? [{ t: 'text', text: label }] : [];
}

/** 预览节点拍平成纯文本（搜索 / @我 检测 / 无障碍标签用）。 */
export function previewNodesToText(nodes: PreviewNode[]): string {
  return nodes
    .map((n) => (n.t === 'text' ? n.text : n.label || `[表情${n.faceId}]`))
    .join('')
    .trim();
}

// ---------- 灰条 ----------------------------------------------------------

function grayTipNodes(el: Rec, kind: string): PreviewNode[] | null {
  if (kind === 'grayTipRevoke') {
    const text = str(el.recallDisplayText).trim();
    return text ? [{ t: 'text', text }] : null;
  }

  if (kind === 'grayTipFileRecv') {
    const name = str(el.fileName).trim();
    return [{ t: 'text', text: name ? `[文件传输完成] ${name}` : '[文件传输完成]' }];
  }

  if (kind === 'grayTipGroup') {
    return [{ t: 'text', text: groupTipText(el) ?? '[群提示]' }];
  }

  // 戳一戳 / XML 类灰条（表情回应、入群邀请、…）：两种等价编码，XML 更常见。
  const names = nameByUid(el);
  const xml = str(el.grayTipXmlContent);
  if (xml) {
    const nodes = parseGtipXml(xml, names);
    if (nodes.length) return nodes;
  }
  const tipJson = str(el.tipJson);
  if (tipJson) {
    const nodes = parseTipJson(tipJson, names);
    if (nodes.length) return nodes;
  }
  return null;
}

/**
 * 群提示（入群 / 退群 / 禁言 / 解散）。文案与聊天区 `elementText` 保持一致，
 * 字段来自 40051 自带的 groupTipType / user1Nick / user2Nick / muteInfo。
 */
function groupTipText(el: Rec): string | null {
  const user1 = str(el.user1GroupNick) || str(el.user1Nick);
  const user2 = str(el.user2GroupNick) || str(el.user2Nick);
  const mute = el.muteInfo as Rec | undefined;

  if (mute && typeof mute === 'object') {
    const duration = num(mute.duration);
    // mutedUser 为空 = 全员禁言（QQ 只填 operator）；有具体成员则是单人禁言。
    const mutedUser = str((mute.mutedUser as Rec | undefined)?.groupNick) || user2;
    if (mutedUser) return duration > 0 ? `${mutedUser} 被禁言` : `${mutedUser} 被解除禁言`;
    return duration > 0 ? '开启了全员禁言' : '关闭了全员禁言';
  }

  switch (num(el.groupTipType)) {
    case 1:
      // 群成员加入：直接显示入群者昵称（与聊天区 elementText 一致），
      // 不区分邀请/主动加入，也无需 user2。
      return user1 ? `${user1} 加入了群聊` : null;
    case 2:
      return '该群已被群主解散';
    case 3:
      return user1 ? `${user1} 将你移出了群聊` : null;
    case 5:
      return user1 ? `${user1} 退出了群聊` : null;
    default:
      return user1 ? `${user1} 更新了群信息` : null;
  }
}

/**
 * gtip XML → 节点。`<qq>` 是人名、`<nor>`/`<url>` 是文字、`<face>` 是表情。
 * 节点上的 `nm` 属性经常是空的，此时依次退到元素自带的 actionInitiator/Target
 * 昵称、actionAttributes 里按出场序排列的 `uin_str{N}`，最后才是裸 uid ——
 * 全程读元素内部字段，不发请求。
 */
function parseGtipXml(xml: string, names: NameLookup): PreviewNode[] {
  let gtip: Node | undefined;
  try {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    gtip = doc.getElementsByTagName('gtip')[0];
  } catch {
    return [];
  }
  if (!gtip) return [];

  const nodes: PreviewNode[] = [];
  let personIndex = 0;
  for (const node of Array.from(gtip.childNodes)) {
    switch (node.nodeName) {
      case 'qq': {
        const uid = attr(node, 'uin');
        // `jp` 是该节点的 QQ 号（入群邀请类灰条会填），比裸 uid 可读。
        const name = attr(node, 'nm') || names.resolve(uid, personIndex++, attr(node, 'jp'));
        if (name) pushText(nodes, name);
        break;
      }
      case 'nor':
      case 'url':
        pushText(nodes, attr(node, 'txt') || nodeText(node));
        break;
      case 'face': {
        const faceId = Number(attr(node, 'id'));
        if (Number.isFinite(faceId) && faceId > 0) nodes.push({ t: 'face', faceId });
        break;
      }
      default:
        break;
    }
  }
  return nodes;
}

interface TipJsonItem {
  type?: string;
  txt?: string;
  uid?: string;
  uin?: string;
  nm?: string;
}

/** tipJson → 节点。与 gtip XML 等价的 JSON 编码，字段名一一对应。 */
function parseTipJson(raw: string, names: NameLookup): PreviewNode[] {
  let items: TipJsonItem[];
  try {
    items = (JSON.parse(raw) as { items?: TipJsonItem[] }).items ?? [];
  } catch {
    return [];
  }

  const nodes: PreviewNode[] = [];
  let personIndex = 0;
  for (const item of items) {
    if (item.type === 'qq' || item.type === 'url') {
      const uid = item.uid || item.uin || '';
      const name = item.nm || names.resolve(uid, personIndex++) || item.txt || '';
      if (name) pushText(nodes, name);
    } else {
      pushText(nodes, item.txt ?? '');
    }
  }
  return nodes;
}

/**
 * 灰条里人名的本地解析器。优先按 uid 命中元素自带的 actionInitiator/Target
 * 昵称；命中不了就按此人在灰条里的出场序取 actionAttributes 的 `uin_str{N}`
 * （QQ 把参与者的 uin 按同样的顺序平铺在这里），至少给出一个 QQ 号而不是一
 * 串 base64 uid。
 */
interface NameLookup {
  resolve(uid: string, personIndex: number, uinHint?: string): string;
}

function nameByUid(el: Rec): NameLookup {
  const byUid = new Map<string, string>();
  for (const key of ['actionInitiator', 'actionTarget']) {
    const who = el[key] as Rec | undefined;
    if (!who || typeof who !== 'object') continue;
    const uid = str(who.uid);
    const nick = str(who.nickname);
    if (uid && nick) byUid.set(uid, nick);
  }

  const attrs = Array.isArray(el.actionAttributes) ? (el.actionAttributes as Rec[]) : [];
  const attrValue = (key: string): string => {
    const hit = attrs.find((a) => str(a.key) === key);
    return hit ? str(hit.value).trim() : '';
  };

  return {
    resolve(uid, personIndex, uinHint) {
      const known = byUid.get(uid);
      if (known) return known;
      // nick_str1/uin_str1/… 与 <qq> 节点的出场序一一对应（1-based）。
      return (
        attrValue(`nick_str${personIndex + 1}`) ||
        attrValue(`uin_str${personIndex + 1}`) ||
        (uinHint ?? '') ||
        uid
      );
    },
  };
}

// ---------- 工具 ----------------------------------------------------------

/** 相邻文本合并成一个节点，省得渲染层输出一串碎 span。 */
function pushText(nodes: PreviewNode[], text: string): void {
  if (!text) return;
  const last = nodes[nodes.length - 1];
  if (last?.t === 'text') last.text += text;
  else nodes.push({ t: 'text', text });
}

/**
 * 是否含至少一个可见字符。QQ 对纯表情消息会在 displayText 里塞不可见的 sysface
 * 控制符，直接渲染就是一行空白。
 */
function hasVisibleText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

function attr(node: Node, name: string): string {
  const attrs = (
    node as Node & {
      attributes?: { getNamedItem(n: string): { nodeValue?: string | null } | null };
    }
  ).attributes;
  return attrs?.getNamedItem(name)?.nodeValue || '';
}

/** `<nor>正文</nor>` 这种把文字写在元素内容里的写法,属性里没有 `txt`。 */
function nodeText(node: Node): string {
  return (typeof node.textContent === 'string' ? node.textContent : '').trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
