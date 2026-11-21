import { networkFetch } from '@weq/network';
/**
 * 群关键词提醒的「命中处理」（Electron 主进程）。
 *
 * {@link GroupKeywordService}（@weq/service）只负责匹配；命中后落地两件事，都在
 * 这里做 —— 包成 app 层钩子注入，好让 app_context 保持 Electron-free：
 *
 *   1. **系统通知卡片**（Electron Notification）：图标用群头像，点击打开 WeQ 并
 *      跳转至该会话该 seq —— 主进程先聚焦窗口、把跳转请求塞进
 *      {@link pushGroupKeywordJump}，渲染层订阅到后领走执行（见
 *      `bootstrap.onGroupKeywordJump` / `consumeGroupKeywordJump`）。
 *   2. **写 unread 2006 高亮**：把这次命中写进 `msg_unread_info_table`，让会话列表
 *      亮起 `[群提醒词]` 角标，QQ 自己也会显示。
 *
 * 两件事都是 best-effort：失败只记日志，不影响后续消息。
 */

import { Notification } from 'electron';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLogger, logErrorContext, type GroupKeywordHit } from '@weq/service';
import { getAppContext, type AccountServices } from './context/app_context';
import { claimMessageSystemNotification } from './message_notification_dedupe';
import { pushGroupKeywordJump } from './group_keyword_bus';
import { getMainWindow } from './main_window';
import { globalClientState } from './ipc/routers/client_state';
import { PRIVATE_MESSAGE_NOTICE } from '../shared/notification_copy';

const logger = getLogger().child({ scope: 'group-keyword' });

/** 群提醒词在 unread 48902 高亮里的类别码。 */
const GROUP_KEYWORD_KIND = 2006;

/** 群头像缓存的临时文件目录（Notification 图标要一个真实路径）。 */
let iconDir: string | null = null;

/**
 * 处理一次命中：写 2006 高亮 + 弹系统通知。永不抛错。
 */
export function handleGroupKeywordHit(
  hit: GroupKeywordHit,
  copy?: { title: string; body: string },
): void {
  void handle(hit, copy).catch((error) => {
    logger.warn('group keyword hit handling failed', {
      event: 'group-keyword-hit-failed',
      groupCode: hit.groupCode,
      ...logErrorContext(error),
    });
  });
}

async function handle(hit: GroupKeywordHit, copy?: { title: string; body: string }): Promise<void> {
  const ctx = getAppContext();
  const services = ctx.services;
  if (!services) return;

  // 1) 写 2006 高亮（会话列表 / QQ 都能看到 [群提醒词] 角标）。
  await writeHighlight(services, hit);

  // 2) 系统通知（群头像 + 点击跳转）。
  if (copy && ctx.bootstrap?.userConfig.getSettings().notificationEvents?.keyword.system !== false)
    await showNotification(services, hit, copy);
}

async function writeHighlight(services: AccountServices, hit: GroupKeywordHit): Promise<void> {
  // 静态账号（离线快照，非 Android 备份）的库是死的 —— 写进去 QQ 也不会读，
  // 与 markConversationRead 同一套判定，直接跳过写库（仍照常弹通知）。
  const ctx = getAppContext();
  if (ctx.accountIsStatic && !ctx.accountIsAndroidBackup) return;
  const changed = await services.unreadInfo.addHighlight(2, hit.groupCode, {
    kind: GROUP_KEYWORD_KIND,
    msgSeq: Number(hit.msgSeq),
    senderUid: hit.senderUid,
    sendTime: Number(hit.sendTime),
    // 50024 存**命中的关键词**（而不是正文摘要）：会话列表 / 未读跳转坞据此
    // 显示「群提醒词·喵喵喵1」，把多个提醒词区分开。正文本身在系统通知卡片里。
    text: hit.keyword,
  });
  if (changed) {
    logger.info('wrote group keyword highlight', {
      event: 'group-keyword-highlight',
      groupCode: hit.groupCode,
      msgSeq: hit.msgSeq,
    });
  }
}

async function showNotification(
  services: AccountServices,
  hit: GroupKeywordHit,
  copy: { title: string; body: string },
): Promise<void> {
  if (!Notification.isSupported()) return;

  const isPrivate = () => globalClientState().snapshot().values.privacyMode === true;
  const iconPath = isPrivate() ? null : await groupIconPath(services, hit.groupCode);
  if (getAppContext().services !== services) return;

  if (
    !claimMessageSystemNotification(
      services.accountConfig.getRecord()?.configId ?? '',
      'group',
      hit.groupCode,
      String(hit.msgSeq),
    )
  )
    return;
  const hidden = isPrivate();
  const notification = new Notification({
    ...(hidden ? PRIVATE_MESSAGE_NOTICE : copy),
    icon: hidden ? undefined : (iconPath ?? undefined),
    silent: false,
  });
  notification.on('click', () => {
    if (getAppContext().services !== services) return;
    openConversationAt(hit);
  });
  notification.show();
}

/**
 * 点击通知：聚焦主窗口并把「打开该群、跳到该 seq」交给渲染层。跳转请求通过
 * `bootstrap.consumePendingGroupJump`（渲染层轮询/订阅）派发 —— 主进程不做导航。
 */
function openConversationAt(hit: GroupKeywordHit): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  pushGroupKeywordJump({
    groupCode: hit.groupCode,
    msgSeq: hit.msgSeq.toString(),
    msgId: hit.msgId.toString(),
  });
}

/**
 * 群头像写成一个临时文件，供系统通知的 `icon` 使用。优先本地缓存（nt_data），
 * 拿不到就回退到品牌 logo。
 */
async function groupIconPath(services: AccountServices, groupCode: string): Promise<string | null> {
  try {
    const local = await services.avatarResource.resolveByUin('group', groupCode, 'small');
    if (local) return local;
  } catch {
    /* fall through to the CDN write */
  }
  try {
    const icon = await fetchGroupAvatar(groupCode);
    if (!icon) return null;
    if (!iconDir) iconDir = mkdtempSync(join(tmpdir(), 'weq-gk-'));
    const dir = iconDir;
    const path = join(dir, `${groupCode}-${randomBytes(4).toString('hex')}.img`);
    writeFileSync(path, icon);
    return path;
  } catch (error) {
    logger.debug('group avatar fetch failed', {
      event: 'group-keyword-avatar-failed',
      groupCode,
      ...logErrorContext(error),
    });
    return null;
  }
}

/** QQ 群头像 CDN（p.qlogo.cn），失败 / 非图片返回 null。 */
async function fetchGroupAvatar(groupCode: string): Promise<Uint8Array | null> {
  if (!/^\d+$/.test(groupCode)) return null;
  const res = await networkFetch(`https://p.qlogo.cn/gh/${groupCode}/${groupCode}/0`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.length > 0 ? buf : null;
}
