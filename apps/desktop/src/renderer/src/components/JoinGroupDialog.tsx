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
 * 弹窗内容按账号的**实际能力**分四档（由 `account.getGroupJoinState` 的 `mode` 决定），
 * 按钮走对应的加群路径：
 *   1. `already-in` —— 已经在群里：只展示二维码 + 一行「你已在群里」；
 *   2. `inject`     —— QQ 在线且 a2/d2/d2key/guid 齐全：换 authKey 后直接发入群申请
 *                      （OIDB 0x11ec_1，@weq/protocol 的 SendGroupJoinRequest）；
 *   3. `deeplink`   —— QQ 在线但物料不全：换 authKey 后拼 `tencent://groupwpa/`
 *                      深链接，交给系统拉起 QQ 客户端自己发；
 *   4. `browser`    —— QQ 不在线：用系统浏览器打开分享页，手机 QQ 扫码加群。
 *
 * 中间那枚二维码是**分享短链**的 dots 风格渲染（见 GroupJoinQr），四种档位都展示 ——
 * 它是最通用的兜底（手机扫码），也承担「这个群长这样」的视觉锚点。
 */

import { useState, type ReactElement } from 'react';
import { CheckCircle2, Loader2, Users } from 'lucide-react';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { GroupJoinQr } from './GroupJoinQr';
import logoUrl from '@resources/brand/logo.png';

/** `mode` → 主按钮文案与一句引导语。 */
const MODE_COPY = {
  'already-in': {
    hint: '你已经在群里了，无需重复申请。',
    cta: '知道了',
  },
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

/** 四种档位共用的弹窗（内容按 mode 变化）。 */
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

  // 关闭即「不再提醒」：本地立刻隐藏（不等落盘往返），并写入版本号。
  const [dismissed, setDismissed] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string; link?: string } | null>(
    null,
  );

  // 只在**欢迎框已确认**且**加群引导未确认**时显示 —— 这就是「接力」的全部逻辑。
  // 加载中（undefined）一律不显示，避免老用户刚开账号时闪一下。
  if (dismissed) return null;
  if (!shouldPrompt) return null;
  if (!state.data) return null;

  const data = state.data;
  const copy = MODE_COPY[data.mode];

  /**
   * 「不再提醒」—— 取消按钮 / ESC / 点遮罩都走这里：三者语义一致（这条引导我看过了，
   * 别再弹），所以 ESC 与点遮罩都**持久化**版本号，而不是只关掉本次。 */
  async function dismissForever(): Promise<void> {
    setDismissed(true);
    try {
      await acknowledge.mutateAsync();
    } catch {
      // 落盘失败最坏是下次再弹一次，不值得挡住用户。
    }
  }

  async function onPrimary(): Promise<void> {
    // 已在群里 / 纯提示档：主按钮就是「知道了」，等同不再提醒。
    if (data.mode === 'already-in') {
      await dismissForever();
      return;
    }
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
      labelledBy="weq-join-group-title"
      width="min(22rem, calc(100vw - 3rem))"
      onClose={() => void dismissForever()}
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

          {data.inGroup ? (
            <p className="weq-join-group-status is-ok">
              <CheckCircle2 size={12} strokeWidth={2.4} aria-hidden />
              你已在群里
            </p>
          ) : (
            <p className="weq-join-group-hint">{copy.hint}</p>
          )}

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
