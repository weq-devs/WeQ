/**
 * 导出前置检查（pre-flight）—— 从 ExportView 抽出来，供导出中心与聊天页
 * 快捷导出灯箱共用，保证两条入口的拦截/提示行为完全一致。
 *
 * 每个检查只负责「告诉用户问题 + 返回是否继续」，不碰任何导出状态。
 */

import type { AppDialogApi } from '../../lib/dialogUtils';
import { client } from '../../trpc/client';

type EstimateInput = Parameters<typeof client.account.exportPreflight.query>[0];
export async function preflightExportEstimate(
  dialog: AppDialogApi,
  targets: readonly { kind: 'group' | 'c2c'; id: string; name: string }[],
  options: {
    range: { start: number | null; end: number | null };
    formats: readonly string[];
    exportMedia: boolean;
    filter?: EstimateInput['filter'];
  },
): Promise<boolean> {
  if (!targets.length) return false;
  const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  try {
    const results = [];
    // Keep preflight bounded when exporting hundreds of conversations.
    for (const target of targets.slice(0, 3))
      results.push({
        name: target.name,
        ...(await client.account.exportPreflight.query({
          kind: target.kind,
          conv: target.id,
          range: options.range,
          formats: options.formats.filter((f) => f !== 'vcard') as EstimateInput['formats'],
          exportMedia: options.exportMedia,
          filter: options.filter,
        })),
      });
    const first = results[0]!;
    const estimate = results.every((r) => r.estimatedMessageBytes !== null)
      ? results.reduce((sum, r) => sum + r.estimatedMessageBytes!, 0)
      : null;
    const summary = results
      .map(
        (r) =>
          `${r.name}：${r.matchingMessages === null ? `数量未核定，已找到 ${r.matchingLowerBound} 条样本` : `${r.matchingMessages} 条`}`,
      )
      .join('\n');
    return await dialog.confirm(
      '导出预检',
      `${summary}\n${targets.length > 3 ? `已抽样前 3 个，共 ${targets.length} 个会话。\n` : ''}正文估算：${estimate === null ? '未核定' : formatBytes(estimate)}（抽样估算，不含附件、头像、装扮及新增漫游消息）\n临时导出目录：${first.destination}\n可用空间：${formatBytes(first.availableBytes)}${results.some((r) => r.spaceWarning) ? '\n警告：估算正文可能超出当前可用空间。' : ''}`,
      {
        okLabel: '开始导出',
        cancelLabel: '返回',
        tone: results.some((r) => r.spaceWarning) ? 'warning' : 'info',
      },
    );
  } catch (error) {
    dialog.error('导出预检失败', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Pre-flight for 补全缺失媒体: needs an online QQ (to harvest a fresh rkey).
 * Returns false to abort the export. Offline → hard block; 完全离线模式（自动
 * 读取 QQ 内存 关闭）→ warn but allow; then force one fresh rkey harvest.
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
  let attachOn = true;
  try {
    attachOn = (await client.bootstrap.getSettings.query()).autoAttachQq;
  } catch {
    /* treat as on; the forced harvest below still runs */
  }
  if (!attachOn) {
    const ok = await dialog.confirm(
      '完全离线模式已开启',
      '「自动读取 QQ 内存（完整功能）」已关闭（完全离线模式），缺失的图片 / 表情无法从云端补全。是否仍要继续导出？',
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
 * Pre-flight for 在线转录: the抓包会话 must already be armed（灯箱点开开关时 arm）。
 * 未 arm 时硬拦截 —— 否则导出会静默退化成纯本地转写，与用户预期不符。
 */
export async function preflightOnlineTranscribe(dialog: AppDialogApi): Promise<boolean> {
  let armed = false;
  try {
    armed = (await client.account.onlineTranscribeStatus.query()).armed;
  } catch (e) {
    dialog.error('检查在线转录状态失败', e instanceof Error ? e.message : String(e));
    return false;
  }
  if (!armed) {
    await dialog.info(
      '在线转录未开启',
      '「在线转录」需要在导出前打开开关（会先就绪抓包会话）。请返回灯箱重新开启，或关闭「在线转录」后用本地模型转写。',
    );
    return false;
  }
  return true;
}

/** 图片文字识别（自动 OCR）当前的前置状态。 */
export interface OcrReadiness {
  /** 本地识别模型（出文字的那份）已选且已下载。 */
  localReady: boolean;
  /** 筛图模型（只判断有没有文字）已选且已下载。 */
  filterReady: boolean;
  /** 在线那条腿能不能走：QQ 在线 + 未开完全离线 + a2 / d2 / d2key / guid 齐全。 */
  onlineCapable: boolean;
  /**
   * 本机**没有可用的推理引擎**时的原因（如 macOS Intel 没有 onnxruntime 二进制）。
   * 非空时本地那两条腿一定是 false —— 这时候别再提示用户「去下载模型」。
   */
  localEngineBlocker: string | null;
}

/**
 * 探一遍图片文字识别的前置条件（灯箱的开关注灰、预筛选提示、导出前的拦截都用它）。
 *
 * 口径与主进程完全一致（见 `account.ts` 的 `ocrOnlineBlocker` / `resolveLocalOcrModel`）：
 *   - OCR 总开关：`localReady || onlineCapable` 有一个满足就能开；
 *   - 「在线识别」开关：只在 `onlineCapable` 时可开（在线那条腿既借 QQ 进程发包、
 *     又要现签一条媒体 rkey）；
 *   - 预筛选：`filterReady` 才跑，否则直接全部送识别（会慢很多，灯箱里提示下载）。
 */
export async function ocrReadiness(): Promise<OcrReadiness> {
  const state: OcrReadiness = {
    localReady: false,
    filterReady: false,
    onlineCapable: false,
    localEngineBlocker: null,
  };
  try {
    const access = await client.account.getGroupAlbumAccessState.query();
    state.onlineCapable = Boolean(
      access.qqOnline &&
        access.attachEnabled &&
        access.hasA2 &&
        access.hasD2 &&
        access.hasD2Key &&
        access.hasGuid,
    );
  } catch {
    /* 读不到就当离线；下面本地模型那条腿还能救 */
  }
  try {
    const settings = await client.bootstrap.getSettings.query();
    const models = await client.bootstrap.ocrModels.query();
    const ocrId = settings.ocr.modelId;
    const filterId = settings.ocr.filterModelId;
    // 平台能力优先：引擎都跑不起来时，「模型下好了」不算数（主进程的
    // `resolveLocalOcrModel` / `resolveLocalOcrFilterModel` 是同一个口径）。
    state.localEngineBlocker = models.engineBlocker;
    state.localReady = Boolean(
      !models.engineBlocker && ocrId && models.models.find((m) => m.id === ocrId)?.downloaded,
    );
    state.filterReady = Boolean(
      !models.engineBlocker && filterId && models.models.find((m) => m.id === filterId)?.downloaded,
    );
  } catch {
    /* 模型状态读不到按未就绪处理 */
  }
  return state;
}

/**
 * Pre-flight for 图片文字识别: 在线可用 或 本地识别模型下好了，二选一即可。
 * 都没有就硬拦截（点了也识别不出来）。
 */
export async function preflightOcrImages(dialog: AppDialogApi): Promise<boolean> {
  const ready = await ocrReadiness();
  if (!ready.onlineCapable && !ready.localReady) {
    await dialog.info(
      '无法识别图片文字',
      ready.localEngineBlocker
        ? `${ready.localEngineBlocker}这台机器上只能走在线识别：请先登录该账号的 QQ 客户端并关闭完全离线模式，再重试；或关闭该选项后继续导出。`
        : '「图片文字识别」需要在线 QQ（用服务端识别），或者先下载一个本地识别模型' +
            '（设置 → 图片识别）。请处理后重试，或关闭该选项后继续导出。',
    );
    return false;
  }
  if (!ready.filterReady) {
    // 预筛选是强烈建议项：没有它每张图都要跑一遍识别模型，导出会慢很多。
    const ok = await dialog.confirm(
      '未下载筛图模型',
      '没有筛图模型就没办法先甩掉风景 / 人像这类没有文字的图，每张图都会送进识别模型，' +
        '导出会慢很多（只有 1.7 MB，导出面板的「图片识别」栏里可以直接下载）。是否继续导出？',
      { okLabel: '继续导出', cancelLabel: '返回', tone: 'warning' },
    );
    if (!ok) return false;
  }
  return true;
}

/**
 * Pre-flight for 补全缺失消息: needs an online QQ *and* 完全离线模式 off
 * (自动读取 QQ 内存 开启) — the roam pull goes through the live SSO channel.
 * 离线时不再硬阻断：仍会从本地漫游缓存读取已缓存的消息（聊天页此前拉过的
 * 窗口直接命中），只是无法联网补拉。
 */
export async function preflightMessageCompletion(dialog: AppDialogApi): Promise<boolean> {
  let state: { qqOnline: boolean; attachEnabled: boolean };
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
  if (!state.attachEnabled) {
    await dialog.info(
      '完全离线模式已开启',
      '「自动读取 QQ 内存（完整功能）」已关闭，无法联网补拉服务端消息；将仅从本地漫游缓存读取。',
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
