/**
 * 「加入 WeQ 交流群」引导弹窗。
 *
 * 与首次运行欢迎框是**接力关系**（不是并列）：欢迎框先弹，确认之后这一条才出现。
 * 所以全新用户看到「欢迎框 → 加群引导」，老用户升级后只看到加群引导 —— 判据是
 * `bootstrap.getWelcomeAcknowledged` 已经为真 + `getJoinGroupPromptAcknowledged`
 * 仍为假（见渲染条件）。
 *
 * 弹出次数由 `UserConfigService` 的 `joinGroupPromptVersion` 钉死：**只弹一次**。
 * 点「立即加群」或「不再提醒」都写这个版本号，之后同版本内不再出现（版本号可抬，
 * 见 service 的 JOIN_GROUP_PROMPT_VERSION）。
 *
 * **已经在群里就不弹**：既然人已经在群里，加群引导没有任何意义（弹了也只是让用户
 * 关掉），所以 `getGroupJoinState().inGroup` 为真时本组件直接返回 null。好在「已加入」
 * 是本地群列表（`group_list`）就能判定的，不依赖在线状态。
 *
 * 弹窗内容按账号的**实际能力**分三档（由 `account.getGroupJoinState` 的 `mode` 决定），
 * 按钮走对应的加群路径：
 *   1. `inject`     —— QQ 在线且 a2/d2/d2key/guid 齐全：换 authKey 后直接发入群申请
 *                      （OIDB 0x11ec_1，@weq/protocol 的 SendGroupJoinRequest）；
 *   2. `deeplink`   —— QQ 在线但物料不全：换 authKey 后拼 `tencent://groupwpa/`
 *                      深链接，交给系统拉起 QQ 客户端自己发；
 *   3. `browser`    —— QQ 不在线：用系统浏览器打开分享页，手机 QQ 扫码加群。
 *
 * 中间那枚二维码是**分享短链**的 dots 风格渲染（见 GroupJoinQr）—— 它是最通用的兜底
 * （手机扫码），也承担「这个群长这样」的视觉锚点。
 */

import { useState, type ReactElement } from 'react';
import { Loader2, Users } from 'lucide-react';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { GroupJoinQr } from './GroupJoinQr';
import logoUrl from '@resources/brand/logo.png';

/** `mode` → 主按钮文案与一句引导语。 */
const MODE_COPY = {
  inject: {
    hint: '点击下方按钮，直接以当前登录的 QQ 发送入群申请。',
    cta: '立即加群',
  },
  deeplink: {
    hint: '点击下方按钮，将唤起 QQ 客户端发送入群申请。',
    cta: '立即加群',
  },
  browser: {
    hint: 'QQ 当前不在线，点击下方按钮用浏览器打开分享页，手机 QQ 扫码加群。',
    cta: '立即加群',
  },
} as const;

/** 加群引导弹窗（内容按 mode 变化）。 */
export function JoinGroupDialog(): ReactElement | null {
  const welcome = trpc.bootstrap.getWelcomeAcknowledged.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const ack = trpc.bootstrap.getJoinGroupPromptAcknowledged.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  // 只在真的要弹的时候才查（这个查询要读本地群列表）。欢迎框还没确认时，
  // 加群引导排在它后面，没必要提前打这一枪。
  const shouldPrompt = welcome.data === true && ack.data === false;
  const state = trpc.account.getGroupJoinState.useQuery(undefined, {
    enabled: shouldPrompt,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const acknowledge = trpc.bootstrap.acknowledgeJoinGroupPrompt.useMutation();
  const join = trpc.account.joinProjectGroup.useMutation();

  // 点外与 Escape 只隐藏本次；只有明确选择「不再提醒」才写入版本号。
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string; link?: string } | null>(
    null,
  );

  // 只在**欢迎框已确认**且**加群引导未确认**时显示 —— 这就是「接力」的全部逻辑。
  // 加载中（undefined）一律不显示，避免老用户刚开账号时闪一下。
  if (dismissed) return null;
  if (!shouldPrompt) return null;
  if (!state.data) return null;
  // 已经在群里：不弹。也就顺带不写版本号 —— 万一以后退群了，这条引导还能再出现一次。
  if (state.data.inGroup) return null;

  const data = state.data;
  const copy = MODE_COPY[data.mode];

  /** 明确选择不再提醒时持久化版本号。 */
  async function dismissForever(): Promise<void> {
    setDismissed(true);
    try {
      await acknowledge.mutateAsync();
    } catch {
      // 落盘失败最坏是下次再弹一次，不值得挡住用户。
    }
  }

  async function onPrimary(): Promise<void> {
    setNote(null);
    try {
      const result = await join.mutateAsync();
      if (result.action === 'inject') {
        setNote({ tone: 'ok', text: '入群申请已发送，请在 QQ 里留意群通知。' });
      } else if (result.action === 'deeplink') {
        setNote({
          tone: 'ok',
          text: '已唤起 QQ，请在客户端里确认入群申请。',
          ...(result.link ? { link: result.link } : {}),
        });
      } else {
        setNote({
          tone: 'ok',
          text: '已用浏览器打开分享页，扫码即可加群。',
          ...(result.link ? { link: result.link } : {}),
        });
      }
      // 动作已经落地，这条引导不再出现。
      await acknowledge.mutateAsync();
    } catch (error) {
      setNote({
        tone: 'err',
        text: `加群失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const busy = join.isLoading;

  return (
    <Modal
      presentation="popover"
      labelledBy="weq-join-group-title"
      width="min(22rem, calc(100vw - 3rem))"
      onClose={busy || acknowledge.isLoading ? undefined : () => setDismissed(true)}
    >
      <div className="weq-join-group">
        <header className="weq-join-group-head">
          <img src={logoUrl} alt="" width={52} height={52} className="weq-join-group-avatar" />
          <h2 id="weq-join-group-title" className="weq-join-group-title">
            加入 {data.groupName}
          </h2>
          <p className="weq-join-group-sub">
            <Users size={11} strokeWidth={2} aria-hidden />
            群号 {data.groupCode}
          </p>
        </header>

        <div className="weq-join-group-body">
          <div className="weq-join-group-qr">
            <GroupJoinQr url={data.shareUrl} size={196} />
          </div>

          <p className="weq-join-group-hint">{copy.hint}</p>

          {note ? (
            <div className={`weq-join-group-note is-${note.tone}`}>
              <span>{note.text}</span>
              {note.link ? <code className="weq-join-group-link">{note.link}</code> : null}
            </div>
          ) : null}
        </div>

        <footer className="weq-join-group-foot">
          <button
            type="button"
            className="weq-action-soft weq-join-group-btn"
            onClick={() => void dismissForever()}
            disabled={busy || acknowledge.isLoading}
          >
            不再提醒
          </button>
          <button
            type="button"
            className="weq-action-primary weq-join-group-btn"
            onClick={() => void onPrimary()}
            disabled={busy || acknowledge.isLoading}
          >
            {busy ? (
              <Loader2 size={12} strokeWidth={2.2} className="animate-spin" aria-hidden />
            ) : null}
            {copy.cta}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
