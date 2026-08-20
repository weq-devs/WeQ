/**
 * FlashTransferService — QQ 闪传（flash transfer / fileset）分享链接 + 群反馈上传。
 *
 * 与 PeerStatsService 同构：注入发生在账号 bootstrap，这里只负责在已注入的
 * 在线 pid 上发包。QQ 离线 / 风控失败原样上抛，由 router 统一转成用户提示。
 *
 * 群反馈路径（uploadBundleToGroup）：「发起 fileset → 拿到 filesetId 立即发闪传
 * 消息 → 上传在后台继续」。消息先到，文件随后传完即可被对端下载。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  createFlashFileset,
  finishFlashUpload,
  GetFilesetDetail,
  SendFlashMsg,
  SendTuwenArk,
  type FlashUploadItem,
  type FlashUploadOptions,
} from '@weq/protocol';
import { getLogger } from '../common/logger';

const logger = getLogger().child({ scope: 'flash-transfer' });

export class FlashTransferService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    _session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /** 用 filesetUuid 换取闪传分享链接（拿不到时为 ''）。 */
  async getShareLink(filesetUuid: string): Promise<string> {
    const entries = await GetFilesetDetail.invoke(this.nt, this.resolvePid(), {
      filesetUuid,
    });
    return entries.find((entry) => entry.shareUrl !== '')?.shareUrl ?? '';
  }

  /**
   * 群反馈：把一组本地文件（正文 + 日志）以闪传形式发到群聊。
   *
   * 0x93cf 申请到 filesetId 后立刻 0x93d7 发消息，不等上传完成；commit →
   * complete → 缩略图 prepare → 并行 100/103/分片上传等剩余步骤在后台执行。
   * 返回时消息已发出；上传结果只记日志（失败则对端暂时无法下载该 fileset）。
   */
  async uploadBundleToGroup(params: {
    files: FlashUploadItem[];
    options: FlashUploadOptions;
    groupId: number;
  }): Promise<{ filesetUuid: string; shareUrl: string }> {
    const pid = this.resolvePid();
    const pending = await createFlashFileset(this.nt, pid, params.files, params.options);
    await SendFlashMsg.invoke(this.nt, pid, {
      filesetUuid: pending.filesetUuid,
      groupId: params.groupId,
    });

    // 消息已发出；上传继续在后台完成（不阻塞调用方）。
    void finishFlashUpload(this.nt, pid, pending).catch((error: unknown) => {
      logger.error('feedback flash upload failed in background', {
        event: 'feedback-flash-upload-failed',
        filesetUuid: pending.filesetUuid,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    });

    return { filesetUuid: pending.filesetUuid, shareUrl: pending.shareUrl };
  }

  /** 群反馈：把已有 GitHub issue/PR 以图文 Ark 卡片发到群聊（0xdc2_34）。 */
  async sendTuwenArkToGroup(params: {
    groupId: number;
    /** 卡片标题（如 `Issue #123` / `PR #45`）。 */
    cardTitle: string;
    /** 卡片描述（issue/PR 原标题）。 */
    desc: string;
    jumpUrl: string;
    previewUrl: string;
  }): Promise<void> {
    await SendTuwenArk.invoke(this.nt, this.resolvePid(), {
      targetId: params.groupId,
      peerType: 1,
      title: params.cardTitle,
      desc: params.desc,
      summary: '[分享]',
      jumpUrl: params.jumpUrl,
      previewUrl: params.previewUrl,
    });
  }
}
