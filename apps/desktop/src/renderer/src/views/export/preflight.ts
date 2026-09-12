/**
 * 导出前置检查（pre-flight）—— 从 ExportView 抽出来，供导出中心与聊天页
 * 快捷导出灯箱共用，保证两条入口的拦截/提示行为完全一致。
 *
 * 每个检查只负责「告诉用户问题 + 返回是否继续」，不碰任何导出状态。
 */

import type { AppDialogApi } from '../../lib/dialogUtils';
import { client } from '../../trpc/client';

/**
 * Pre-flight for 补全缺失媒体: needs an online QQ (to harvest a fresh rkey).
 * Returns false to abort the export. Offline → hard block; 完全离线模式（自动
 * 注入 QQ 关闭）→ warn but allow; then force one fresh rkey harvest.
 */
export async function preflightMediaCompletion(dialog: AppDialogApi): Promise<boolean> {
  let online = false;
  try {
    online = (await client.account.getGroupAlbumAccessState.query()).qqOnline;
  } catch (e) {
    dialog.error('检查在线状态失败', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!online) {
    // 没有在线 QQ 时，若已启用外部 rkey 服务器（如 NapCat），图片/表情仍可由
    // 它补全（媒体下载会自动回退），不再硬拦截；否则保持原来的提示。
    let hasExternalRkey = false;
    try {
      const settings = await client.bootstrap.getSettings.query();
      hasExternalRkey = settings.externalRkey.enabledServerId != null;
    } catch {
      /* 读取失败按未配置处理，保留硬拦截 */
    }
    if (!hasExternalRkey) {
      await dialog.info(
        '无法补全媒体',
        '未检测到在线的 QQ 实例。补全缺失媒体需要登录该账号的 QQ 客户端以获取下载凭证（rkey）。请登录后重试，或关闭「补全缺失媒体」后继续导出。',
      );
      return false;
    }
  }
  let injectOn = true;
  try {
    injectOn = (await client.bootstrap.getSettings.query()).autoInjectQq;
  } catch {
    /* treat as on; the forced harvest below still runs */
  }
  if (!injectOn) {
    const ok = await dialog.confirm(
      '完全离线模式已开启',
      '「自动注入 QQ（完整功能）」已关闭（完全离线模式），缺失的图片 / 表情无法从云端补全。是否仍要继续导出？',
      { okLabel: '继续导出', cancelLabel: '返回', tone: 'warning' },
    );
    if (!ok) return false;
  }
  // Explicit one-shot rkey refresh right before exporting.
  try {
    await client.account.refreshRkeys.mutate();
  } catch {
    /* best-effort; export proceeds with whatever rkeys exist */
  }
  return true;
}

/**
 * Pre-flight for 语音自动转写: a transcription model must be selected *and*
 * fully downloaded (设置 → 语音转录). Returns false to abort, pointing the user
 * at the settings page — mirrors the per-message transcribe checks.
 */
export async function preflightVoiceTranscribe(dialog: AppDialogApi): Promise<boolean> {
  let modelId = '';
  try {
    modelId = (await client.bootstrap.getSettings.query()).voiceTranscribe.modelId;
  } catch (e) {
    dialog.error('检查语音模型失败', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!modelId) {
    await dialog.info(
      '未配置语音模型',
      '「语音自动转写」需要先下载并选择一个转录模型。请前往「设置 → 语音转录」下载模型后重试，或关闭「语音自动转写」后继续导出。',
    );
    return false;
  }
  try {
    const models = await client.bootstrap.voiceModels.query();
    const model = models.find((m) => m.id === modelId);
    if (!model?.downloaded) {
      await dialog.info(
        '语音模型未下载',
        `转录模型「${model?.name ?? modelId}」尚未下载完成。请前往「设置 → 语音转录」完成下载后重试，或关闭「语音自动转写」后继续导出。`,
      );
      return false;
    }
  } catch (e) {
    dialog.error('检查语音模型失败', e instanceof Error ? e.message : String(e));
    return false;
  }
  return true;
}

/**
 * Pre-flight for 补全缺失消息: needs an online QQ *and* 完全离线模式 off
 * (自动注入 QQ 开启) — the roam pull goes through the live SSO channel.
 * 离线时不再硬阻断：仍会从本地漫游缓存读取已缓存的消息（聊天页此前拉过的
 * 窗口直接命中），只是无法联网补拉。
 */
export async function preflightMessageCompletion(dialog: AppDialogApi): Promise<boolean> {
  let state: { qqOnline: boolean; injectEnabled: boolean };
  try {
    state = await client.account.getGroupAlbumAccessState.query();
  } catch (e) {
    dialog.error('检查在线状态失败', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!state.qqOnline) {
    await dialog.info(
      '未检测到在线 QQ',
      '「补充漫游消息」将只读取本地缓存数据库中的漫游消息，无法联网补拉缺失消息。可稍后打开 QQ 再导出完整版本。',
    );
    return true;
  }
  if (!state.injectEnabled) {
    await dialog.info(
      '完全离线模式已开启',
      '「自动注入 QQ（完整功能）」已关闭，无法联网补拉服务端消息；将仅从本地漫游缓存读取。',
    );
    return true;
  }
  return true;
}

/**
 * Pre-flight for QQ 空间导出: a live QQ instance must be logged in (the QZone
 * web CGI needs this account's skey/pskey). Returns false to abort with a
 * prompt to open QQ.
 */
export async function preflightQqOnline(dialog: AppDialogApi): Promise<boolean> {
  let online = false;
  try {
    online = (await client.account.getGroupAlbumAccessState.query()).qqOnline;
  } catch (e) {
    dialog.error('检查在线状态失败', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!online) {
    await dialog.info(
      '需要打开 QQ',
      '导出 QQ 空间需要登录该账号的 QQ 客户端以获取访问凭证。请打开并登录 QQ 后重试。',
    );
    return false;
  }
  return true;
}
