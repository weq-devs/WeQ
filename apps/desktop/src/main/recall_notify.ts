/**
 * 防撤回通知的「拦下处理」（Electron 主进程）。
 *
 * 服务层的 {@link AntiRecallService}（@weq/service）自己监听 nt_msg.db、从
 * `weq_recall_log` 里 drain 出新撤回记录，然后回调注入的钩子。这里就是那个钩子：
 *
 *   1. **系统通知卡片**（Electron Notification）：标题=会话名 + 「撤回提醒」，正文=
 *      谁撤了谁的消息；图标用会话头像。点击打开 WeQ 并把「打开该会话、跳到该 seq」
 *      交给渲染层（见 {@link pushConversationJump} /
 *      `bootstrap.onConversationJump` / `consumeConversationJump`）。
 *   2. 不做任何写库 —— 撤回消息本身已被触发器原地保留。
 *
 * 与服务层解耦：本文件认识 Electron，AntiRecallService 不认识（见 app_context 注入）。
 */

import { Notification } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLogger, logErrorContext, type RecallNotifyEvent } from '@weq/service';
import { getAppContext, type AccountServices } from './context/app_context';
import { pushConversationJump } from './group_keyword_bus';
import { getMainWindow } from './main_window';

const logger = getLogger().child({ scope: 'recall-notify' });

/** 会话头像缓存的临时文件目录（Notification 图标要一个真实路径）。 */
let iconDir: string | null = null;

/**
 * 处理一次撤回记录：弹系统通知。永不抛错（服务层的 drain 已 try/catch，这里再兜一层）。
 */
export function handleRecallNotification(event: RecallNotifyEvent): void {
  void handle(event).catch((error) => {
    logger.warn('recall notification failed', {
      event: 'recall-notify-failed',
      conv: event.conv,
      ...logErrorContext(error),
    });
  });
}

async function handle(event: RecallNotifyEvent): Promise<void> {
  if (!Notification.isSupported()) return;
  const ctx = getAppContext();
  const services = ctx.services;
  if (!services) return;

  const [info, iconPath] = await Promise.all([
    describeConversation(services, event),
    conversationIconPath(services, event),
  ]);

  const title = info.name ? `${info.name} · 撤回提醒` : '撤回提醒';
  const body = buildBody(info, event);

  const notification = new Notification({
    title,
    body,
    icon: iconPath ?? undefined,
    silent: false,
  });
  notification.on('click', () => {
    openConversationAt(event);
  });
  notification.show();
}

/** 正文：自己撤回 vs 管理员撤回他人。名字解析失败就以 uid 兜底 / 省略。 */
function buildBody(
  info: { name: string; senderName: string; revokerName: string },
  event: RecallNotifyEvent,
): string {
  const selfRecall = !event.revokeUid || event.revokeUid === event.senderUid;
  if (selfRecall) {
    return info.senderName ? `${info.senderName} 撤回了一条消息` : '有人撤回了一条消息';
  }
  const who = info.revokerName || '管理员';
  return info.senderName ? `${who} 撤回了 ${info.senderName} 的一条消息` : `${who} 撤回了一条消息`;
}

/**
 * 点击通知：聚焦主窗口 + 把「打开该会话、跳到该 seq」交给渲染层。主进程不做导航。
 */
function openConversationAt(event: RecallNotifyEvent): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  const kind = event.kind === 'group' ? 'group' : 'c2c';
  pushConversationJump({ kind, conv: event.conv, seq: event.origSeq });
}

/** 会话显示名 + 发送者 / 撤回者昵称（best-effort，全部失败也有兜底）。 */
async function describeConversation(
  services: AccountServices,
  event: RecallNotifyEvent,
): Promise<{ name: string; senderName: string; revokerName: string }> {
  let name = event.conv;
  let senderName = '';
  let revokerName = '';

  try {
    const contacts = await services.recentContacts.getRecentContact(1000);
    const hit = contacts.find((c) => c.targetUid === event.conv);
    if (hit?.targetDisplayName) name = hit.targetDisplayName;
  } catch {
    /* keep uid/groupCode as the name */
  }

  if (event.kind === 'group') {
    try {
      const detail = await services.groupInfo.getGroupDetail(BigInt(event.conv));
      if (detail?.groupName) name = detail.groupName;
    } catch {
      /* ignore */
    }
    if (event.senderUid) {
      try {
        const m = await services.groupInfo.getMemberInfo(BigInt(event.conv), event.senderUid);
        senderName = m?.card || m?.nick || '';
      } catch {
        /* ignore */
      }
    }
    if (event.revokeUid && event.revokeUid !== event.senderUid) {
      try {
        const m = await services.groupInfo.getMemberInfo(BigInt(event.conv), event.revokeUid);
        revokerName = m?.card || m?.nick || '';
      } catch {
        /* ignore */
      }
    }
  }

  return { name, senderName, revokerName };
}

/** 会话头像写成一个临时文件，供系统通知的 `icon` 使用。 */
async function conversationIconPath(
  services: AccountServices,
  event: RecallNotifyEvent,
): Promise<string | null> {
  try {
    const scope = event.kind === 'group' ? 'group' : 'c2c';
    const local = await services.avatarResource.resolveByUin(
      scope === 'group' ? 'group' : 'user',
      event.conv,
      'small',
    );
    if (local) return local;
  } catch {
    /* fall through to the CDN write */
  }
  try {
    const icon = await fetchAvatar(event);
    if (!icon) return null;
    if (!iconDir) iconDir = mkdtempSync(join(tmpdir(), 'weq-recall-'));
    const dir = iconDir;
    const path = join(dir, `${event.conv}-${randomBytes(4).toString('hex')}.img`);
    writeFileSync(path, icon);
    return path;
  } catch (error) {
    logger.debug('recall avatar fetch failed', {
      event: 'recall-notify-avatar-failed',
      conv: event.conv,
      ...logErrorContext(error),
    });
    return null;
  }
}

/** 群头像用 p.qlogo.cn/gh，私聊用 q1.qlogo.cn 的 uin 头像。失败 / 非图片返回 null。 */
async function fetchAvatar(event: RecallNotifyEvent): Promise<Uint8Array | null> {
  let url: string;
  if (event.kind === 'group') {
    if (!/^\d+$/.test(event.conv)) return null;
    url = `https://p.qlogo.cn/gh/${event.conv}/${event.conv}/0`;
  } else {
    // 私聊 conv 是 uid（u_ 开头），CDN 要 uin —— 拿不到就放弃。
    if (!/^\d+$/.test(event.conv)) return null;
    url = `https://q1.qlogo.cn/g?b=qq&nk=${event.conv}&s=100`;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > 0 ? buf : null;
}
