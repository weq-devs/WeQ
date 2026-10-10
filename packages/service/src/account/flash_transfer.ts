/**
 * FlashTransferService — QQ 闪传（flash transfer / fileset）分享链接 + 群反馈上传。
 *
 * 与 PeerStatsService 同构：注入发生在账号 bootstrap，这里只负责在已注入的
 * 在线 pid 上发包。QQ 离线 / 风控失败原样上抛，由 router 统一转成用户提示。
 *
 * 通用路径（sendFlashTransfer）的时序是「**封面传完才发、主文件后台传**」：申请 fileset
 * → commit/complete → 封面（缩略图）prepare/apply/分片 **传完** → 0x93d7 发消息 →
 * 主文件字节在后台传。
 *
 * 封面必须在 0x93d7 **之前**就绪 —— 实机抓包（2026-10-10，含时间线）里 QQ 是「传完才
 * 发」：0x93cf → 0x93d0 → 0x93db → 0x12a9（封面/主文件 prepare/apply + 分片）→ 0x93d1
 * →（约 25 秒后）0x93d7。封面晚于 0x93d7 时，对端一收到消息就拉 fileset、此时封面还没
 * 登记，卡片只会显示默认封面，且不会重拉。主文件字节仍丢后台，避免大文件卡住发送；
 * 对端靠 commit 的元数据就能看到文件清单。上传结果只写日志（进度另走
 * FlashTransferFilesService）。群反馈路径（uploadBundleToGroup）复用同一条。
 */
import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import {
  createFlashFileset,
  GetFilesetDetail,
  SendFlashMsg,
  SendTuwenArk,
  stageFlashFileset,
  uploadFlashMainFiles,
  type FlashUploadItem,
  type FlashUploadOptions,
  type FlashUploaderInfo,
  type SendTuwenArkResult,
} from '@weq/protocol';
import { getLogger } from '../common/logger';

const logger = getLogger().child({ scope: 'flash-transfer' });

export class FlashTransferService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket'>,
    private readonly session: AccountSession,
    private readonly resolvePid: () => number,
  ) {}

  /**
   * 发一条闪传（fileset）消息给私聊 / 群聊 —— 输入框「闪传」用的通用路径。
   *
   * 时序（**封面传完才发、主文件后台传**）：申请 fileset（0x93cf）→ commit/complete
   * （0x93d0/0x93db）→ 封面缩略图（0x12a9 三段 + 分片）**传完** → 0x93d7 发消息 →
   * **立刻返回**；只有主文件分片上传在返回后于后台跑。
   *
   * 封面必须排在 0x93d7 之前：对端一收到消息就拉 fileset，封面没登记就只会显示默认
   * 封面（实机抓包见类注释）。主文件仍不阻塞调用方；调用方要等上传收尾时可 await
   * 返回的 `uploaded`。
   *
   * 与 `uploadBundleToGroup` 的差别只有目标与命名：这条接受任意私聊 / 群聊目标，
   * 且可以由调用方给封面 PNG 路径（`thumbPath`）。
   */
  async sendFlashTransfer(params: {
    files: FlashUploadItem[];
    /** `c2c` = 私聊（可给 QQ 号或 uid），`group` = 群聊（群号）。 */
    peerType: 'c2c' | 'group';
    targetId: string;
    /** fileset 标题（卡片名）；缺省单文件用文件名、多文件用「<首文件>等N个文件」。 */
    name?: string;
    /** 可选封面：**真实 PNG** 路径（协议会读 IHDR 取宽高并上传为缩略图）。 */
    thumbPath?: string;
    uploader: FlashUploaderInfo;
  }): Promise<{ filesetUuid: string; shareUrl: string; uploaded: Promise<void> }> {
    const pid = this.resolvePid();
    const pending = await createFlashFileset(this.nt, pid, params.files, {
      ...(params.name?.trim() ? { name: params.name.trim() } : {}),
      ...(params.thumbPath ? { thumbPath: params.thumbPath } : {}),
      uploader: params.uploader,
    });

    // commit/complete 登记文件清单，并把**封面在发消息前传完**（stage = commit +
    // 封面 prepare/apply/分片）。两步都必须在 0x93d7 之前：前者让对端点开就有文件
    // 清单，后者让卡片一到就有封面而不是默认图（见类注释的实机时序）。
    await stageFlashFileset(this.nt, pid, pending);

    if (params.peerType === 'group') {
      const groupId = Number(params.targetId.trim());
      if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        throw new Error(`群号不合法：${params.targetId}`);
      }
      await SendFlashMsg.invoke(this.nt, pid, { filesetUuid: pending.filesetUuid, groupId });
    } else {
      await SendFlashMsg.invoke(this.nt, pid, {
        filesetUuid: pending.filesetUuid,
        targetUid: this.resolveUid(params.targetId),
      });
    }

    // 消息已发出；只剩主文件的字节上传丢后台（封面刚才已就绪）。
    const uploaded = (async () => {
      await uploadFlashMainFiles(this.nt, pid, pending);
    })().catch((error: unknown) => {
      logger.error('flash upload failed in background', {
        event: 'flash-upload-failed',
        filesetUuid: pending.filesetUuid,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    });

    return { filesetUuid: pending.filesetUuid, shareUrl: pending.shareUrl, uploaded };
  }

  /**
   * 私聊目标 → uid。
   *
   * 纯数字按 QQ 号去本地目录（`nt_uid_mapping_table`）换 uid —— 闪传的发送接口只吃
   * uid，给 QQ 号是发不出去的；非纯数字原样当 uid。查不到直接报错而不是拿号码硬发。
   */
  private resolveUid(target: string): string {
    const text = target.trim();
    if (!text) throw new Error('私聊闪传需要对方的 QQ 号或 uid。');
    if (!/^\d+$/.test(text)) return text;
    const uid = this.session.uidMap.uidByUin(BigInt(text));
    if (!uid) throw new Error(`本地目录里查不到 ${text} 的 uid，无法发私聊闪传。`);
    return uid;
  }

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
   * 与通用路径同一条时序（封面传完才发、主文件后台传，见 `sendFlashTransfer`）：
   * 0x93cf 申请 → commit/complete → 封面传完 → 0x93d7 发消息并返回 → 主文件上传在
   * 后台跑。上传结果只记日志（失败则对端暂时无法下载该 fileset）。
   */
  async uploadBundleToGroup(params: {
    files: FlashUploadItem[];
    options: FlashUploadOptions;
    groupId: number;
  }): Promise<{ filesetUuid: string; shareUrl: string; uploaded: Promise<void> }> {
    // 与通用路径同一套时序（只差目标固定成群）。
    return this.sendFlashTransfer({
      files: params.files,
      peerType: 'group',
      targetId: String(params.groupId),
      ...(params.options.name ? { name: params.options.name } : {}),
      ...(params.options.thumbPath ? { thumbPath: params.options.thumbPath } : {}),
      uploader: params.options.uploader,
    });
  }

  /**
   * 发一张**图文 Ark 卡片**（0xdc2_34）：服务端按标题/描述/跳转链接/预览图生成卡片
   * 直接下发到私聊或群聊。**输入框「图文」也走这条路** —— 同群反馈的 GitHub
   * issue/PR 卡片（见 {@link sendTuwenArkToGroup}）是同一条协议，而不是客户端自己
   * 拼一段 ark JSON 当 `lightApp` 元素发出去。
   *
   * 返回服务端的下发结果 —— **必须检查 `result.errorCode`**：OIDB 外层
   * errorCode=0 不代表卡片发出去了，例如 PC/Linux 端用 Android 的 appId 会拿到
   * 901501(`rule type not match appid`)。调用方不要再当它是 void。
   */
  async sendTuwenArk(params: {
    /** 私聊 = 对方 QQ 号（peerType 0）；群聊 = 群号（peerType 1）。 */
    targetId: number;
    /** 0 = 私聊（C2C），1 = 群聊。 */
    peerType: 0 | 1;
    title: string;
    desc: string;
    jumpUrl: string;
    previewUrl: string;
    /** 会话列表外显文案；缺省 `[分享]`（与 SnowLuma / 群反馈卡片一致）。 */
    summary?: string;
  }): Promise<SendTuwenArkResult> {
    return SendTuwenArk.invoke(this.nt, this.resolvePid(), {
      targetId: params.targetId,
      peerType: params.peerType,
      title: params.title,
      desc: params.desc,
      summary: params.summary?.trim() || '[分享]',
      jumpUrl: params.jumpUrl,
      previewUrl: params.previewUrl,
    });
  }

  /**
   * 群反馈：把已有 GitHub issue/PR 以图文 Ark 卡片发到群聊（0xdc2_34）。
   *
   * 与 {@link sendTuwenArk} 同一条协议，只是固定群聊 + 标题/预览图的调用方约定。
   * 同样**必须检查 `result.errorCode`**（详见 {@link sendTuwenArk}）。
   */
  async sendTuwenArkToGroup(params: {
    groupId: number;
    /** 卡片标题（如 `Issue #123` / `PR #45`）。 */
    cardTitle: string;
    /** 卡片描述（issue/PR 原标题）。 */
    desc: string;
    jumpUrl: string;
    previewUrl: string;
  }): Promise<SendTuwenArkResult> {
    return this.sendTuwenArk({
      targetId: params.groupId,
      peerType: 1,
      title: params.cardTitle,
      desc: params.desc,
      jumpUrl: params.jumpUrl,
      previewUrl: params.previewUrl,
    });
  }
}
