// @ts-nocheck
/**
 * 输入框工具栏「红包」按钮弹出的面板。
 *
 * **只做前端**：面板收齐「类型 × 金额 / 个数 / 祝福语（口令）」后，把一份
 * {@link RedPacketDraft} 交回上层（`onSend`），由 chatPane → 应用层补会话目标、
 * 走 IPC 下单出码（`hb_pc_pre_pack`）。发不出去会抛出，面板保留已填内容。
 *
 * 可发的类型按会话类型区分（这是服务端口径，也是这个面板唯一的真相）：
 *   - 私聊两档：**等额普通**、**拼手气口令**；私聊只有 1 个领取人，不提供拼手气普通；
 *   - 群聊三档：**等额普通**、**拼手气普通**、**拼手气口令**。
 *
 * 也就是说：口令红包**必然是拼手气**（真机抓包规则）；「拼手气普通」只在群聊出现。
 *
 * 规则：
 *   - 私聊固定 1 个，不显示个数；
 *   - 等额红包填「单个金额」（总金额 = 单个 × 个数）；
 *   - 拼手气红包填「总金额」，且金额（分）必须**大于等于**个数（每人至少 1 分）；
 *   - 口令红包的口令与普通红包的祝福语共用协议侧 f5；
 *   - 祝福语 / 口令默认「恭喜发财」，**直接写在红包封面上**（点封面上的字就能改，
 *     所见即所发）。
 *
 * 下单后会拿到一张二维码：真正付款由手机 QQ 用当前账号拉起支付页，扫码只是回退。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  Coins,
  Gift,
  KeyRound,
  Minus,
  Plus,
  RefreshCw,
  SendHorizontal,
  Shuffle,
  X,
} from 'lucide-react';
import { resourceUrl } from '../../lib/resourceUrl';
import { cn } from './classNames';

/** 红包类型：等额普通 / 拼手气普通 / 口令（口令的等额或拼手气由会话类型决定）。 */
export type RedPacketKind = 'normal' | 'lucky' | 'password';

/** 面板收集到的红包参数（金额单位统一为**分**）。 */
export type RedPacketDraft = {
  /** 是否拼手气（false = 等额）。 */
  lucky: boolean;
  /** 口令红包的口令；非口令红包为 null。 */
  password: string | null;
  /** 普通 / 拼手气红包的祝福语；口令红包为 null（协议侧与口令共用 f5）。 */
  wishing: string | null;
  /** 红包个数。 */
  totalNum: number;
  /** 总金额，单位分。 */
  totalAmount: number;
};

/** 一档类型：文案 + 这句话是不是拼手气 / 口令。 */
type KindMeta = {
  label: string;
  caption: string;
  lucky: boolean;
  password: boolean;
};

/** 类型文案与语义：口令红包必然是拼手气（真机抓包规则），拼手气普通只在群聊出现。 */
function kindMeta(kind: RedPacketKind): KindMeta {
  switch (kind) {
    case 'lucky':
      return { label: '拼手气普通', caption: '金额随机', lucky: true, password: false };
    case 'password':
      return { label: '拼手气口令', caption: '凭口令随机领', lucky: true, password: true };
    default:
      return { label: '等额普通', caption: '每人金额相同', lucky: false, password: false };
  }
}

/** 元（字符串）→ 分；非法 / 非正数返回 0。 */
function parseAmountYuan(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

/** 分 → 元，保留两位。 */
function formatFen(fen: number): string {
  return (fen / 100).toFixed(2);
}

/** 金额输入清洗：只留数字与一个小数点，小数最多两位。 */
function sanitizeAmount(text: string): string {
  const next = text.replace(/[^\d.]/g, '');
  const dot = next.indexOf('.');
  if (dot === -1) return next;
  return `${next.slice(0, dot + 1)}${next
    .slice(dot + 1)
    .replace(/\./g, '')
    .slice(0, 2)}`;
}

/** 私聊两档：等额普通 / 拼手气口令。 */
const PRIVATE_KINDS: RedPacketKind[] = ['normal', 'password'];
/** 群聊三档：等额普通 / 拼手气普通 / 拼手气口令。 */
const GROUP_KINDS: RedPacketKind[] = ['normal', 'lucky', 'password'];

/** 封面上的字自动长高：一行祝福语不空转，长口令换行后也不会被截断。 */
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export function RedPacketPanel({
  panelRef,
  group,
  disabled,
  disabledHint,
  passwords,
  passwordsLoading,
  onReloadPasswords,
  onSend,
  onClose,
}: {
  panelRef?: RefObject<HTMLDivElement | null>;
  /** 群聊：三档类型 + 个数；私聊：两档类型，固定 1 个。 */
  group: boolean;
  /** QQ 未在线 / 完全离线等：面板照常填，只是发不出去。 */
  disabled: boolean;
  disabledHint: string;
  /** 口令候选池（来自服务端 SsoGetToken）。 */
  passwords: string[];
  passwordsLoading: boolean;
  onReloadPasswords: () => void;
  onSend: (draft: RedPacketDraft) => Promise<void>;
  onClose: () => void;
}) {
  // 先挑类型（口令 / 拼手气只在各自会话里出现），再填参数。
  const [kind, setKind] = useState<RedPacketKind>('normal');
  const [password, setPassword] = useState('');
  // QQ 默认祝福语；改掉会原样写进 f5。
  const [wishing, setWishing] = useState('恭喜发财');
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('1');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const kinds = group ? GROUP_KINDS : PRIVATE_KINDS;
  // 面板不重挂就切会话（私聊 → 群）时，把私聊里不存在的「拼手气」落回等额普通。
  const activeKind: RedPacketKind = kinds.includes(kind) ? kind : 'normal';
  const meta = useMemo(() => kindMeta(activeKind), [activeKind]);
  const { lucky, password: passwordOn } = meta;

  const totalNum = group ? Number(count) : 1;
  const countOk = Number.isInteger(totalNum) && totalNum >= 1;
  const amountFen = parseAmountYuan(amount);
  // 等额红包填单个金额 → 总额 = 单个 × 个数；拼手气直接填总额。
  const totalAmount = lucky ? amountFen : amountFen * (countOk ? totalNum : 0);

  let problem = '';
  if (amountFen <= 0) {
    problem = '请输入金额';
  } else if (group && !countOk) {
    problem = '个数至少 1';
  } else if (group && totalNum > 100) {
    problem = '个数最多 100';
  } else if (lucky && totalAmount < totalNum) {
    problem = '总金额不能少于个数（每人至少 1 分）';
  } else if (passwordOn && password.trim() === '') {
    problem = '请输入口令';
  }

  const canSend = !disabled && !sending && problem === '';

  // 摘要：把「合计 / 每个 / 规则」摊开来，参数少的时候左栏也不会空荡。
  const summaryNote = passwordOn
    ? `${totalNum} 个 · 凭口令领取 · 每人随机`
    : lucky
      ? `${totalNum} 个 · 每人随机 · 至少 1 分`
      : group
        ? `单个 ¥${formatFen(amountFen)} × ${totalNum} 个`
        : '1 个 · 金额固定';

  function stepCount(delta: number): void {
    const current = Number.isInteger(Number(count)) ? Number(count) : 1;
    const next = Math.min(100, Math.max(1, current + delta));
    setCount(String(next));
  }

  async function submit(): Promise<void> {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      await onSend({
        lucky,
        password: passwordOn ? password.trim() : null,
        wishing: passwordOn ? null : wishing.trim() || null,
        totalNum,
        totalAmount,
      });
    } catch (e) {
      // 下单失败（服务端拒绝 / 未在线）：面板留着已填内容，把原因写在底栏。
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  // ── 预览 / 祝福语输入 ──
  // 封面图直接当输入位：字就写在封面正中，改字即改封面（所见即所发）。
  const coverText = passwordOn ? password : wishing;
  const coverPlaceholder = passwordOn ? '输入口令' : '恭喜发财';
  const coverSrc = resourceUrl('img', passwordOn ? 'password_bag.png' : 'normal_bag.png');
  // 封面 / 预览上展示的始终是**合计**（等额私聊时合计就等于输入金额）。
  const previewAmount = totalAmount;

  // 切换类型时封面上的字会换成另一个字段（祝福语 ↔ 口令），不经过 onChange，
  // 所以补一个跟着字走的 effect；输入时 onChange 里那次重算负责**立刻**反馈。
  const coverRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (coverRef.current) autoGrow(coverRef.current);
  }, [coverText, coverPlaceholder]);

  return (
    <div
      className={cn('redpacket-panel')}
      ref={(node) => {
        if (panelRef) panelRef.current = node;
      }}
      role="dialog"
      aria-label="发红包"
    >
      <header className={cn('redpacket-head')}>
        <span className={cn('redpacket-head-title')}>
          <Gift size={14} strokeWidth={2.1} />
          红包
        </span>
        <span className={cn('redpacket-head-kind')}>{meta.label}</span>
        <button
          type="button"
          className={cn('redpacket-close')}
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} strokeWidth={2.4} />
        </button>
      </header>

      <div className={cn('redpacket-body')}>
        {/* 左：类型 → 金额 / 个数 → 明细摘要 →（口令的候选池） */}
        <div className={cn('redpacket-form')}>
          {/* 类型是第一步：先挑类型，口令 / 拼手气才有意义。 */}
          <div className={cn('redpacket-seg')} role="radiogroup" aria-label="红包类型">
            {kinds.map((item) => {
              const itemMeta = kindMeta(item);
              return (
                <button
                  key={item}
                  type="button"
                  className={cn('redpacket-seg-btn', activeKind === item && 'is-active')}
                  role="radio"
                  aria-checked={activeKind === item}
                  onClick={() => setKind(item)}
                >
                  <span className={cn('redpacket-seg-label')}>{itemMeta.label}</span>
                  <span className={cn('redpacket-seg-caption')}>{itemMeta.caption}</span>
                </button>
              );
            })}
          </div>

          <div className={cn('redpacket-row', !group && 'redpacket-row--single')}>
            <label className={cn('redpacket-field')}>
              <span className={cn('redpacket-field-label')}>
                {lucky ? '总金额' : group ? '单个金额' : '金额'}
              </span>
              <div className={cn('redpacket-input-wrap', 'redpacket-input-wrap--amount')}>
                <span className={cn('redpacket-input-cny')}>¥</span>
                <input
                  className={cn('redpacket-input')}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(event) => setAmount(sanitizeAmount(event.target.value))}
                />
              </div>
            </label>

            {/* 群聊才选个数；私聊固定 1 个。 */}
            {group ? (
              <div className={cn('redpacket-field')}>
                <span className={cn('redpacket-field-label')}>个数</span>
                <div className={cn('redpacket-stepper')}>
                  <button
                    type="button"
                    className={cn('redpacket-step')}
                    title="减一"
                    disabled={Number(count) <= 1}
                    onClick={() => stepCount(-1)}
                  >
                    <Minus size={14} strokeWidth={2.4} />
                  </button>
                  <input
                    className={cn('redpacket-count')}
                    inputMode="numeric"
                    value={count}
                    onChange={(event) => setCount(event.target.value.replace(/[^\d]/g, ''))}
                    onBlur={() => {
                      const n = Number(count);
                      if (!Number.isInteger(n) || n < 1) setCount('1');
                    }}
                  />
                  <button
                    type="button"
                    className={cn('redpacket-step')}
                    title="加一"
                    disabled={Number(count) >= 100}
                    onClick={() => stepCount(1)}
                  >
                    <Plus size={14} strokeWidth={2.4} />
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* 明细摘要：金额还没填时当占位，填了就把「合计 / 规则」摊平说清楚。 */}
          <div
            className={cn(
              'redpacket-summary',
              amountFen > 0 && 'is-ready',
              lucky && amountFen > 0 && totalAmount < totalNum && 'is-invalid',
            )}
          >
            <Coins size={15} strokeWidth={2} aria-hidden />
            <div className={cn('redpacket-summary-body')}>
              {amountFen > 0 ? (
                <>
                  <strong className={cn('redpacket-summary-amount')}>
                    合计 ¥{formatFen(totalAmount)}
                  </strong>
                  <span className={cn('redpacket-summary-note')}>{summaryNote}</span>
                </>
              ) : (
                <span className={cn('redpacket-summary-note')}>填好金额后，这里会列出红包明细</span>
              )}
            </div>
          </div>

          {/* 口令的候选池：只在口令这一档出现，选一条即填进封面。 */}
          {passwordOn ? (
            <div className={cn('redpacket-password-box')}>
              <div className={cn('redpacket-password-head')}>
                <span className={cn('redpacket-field-label')}>候选口令</span>
                <button
                  type="button"
                  className={cn('redpacket-reload')}
                  title="换一批口令"
                  aria-label="换一批口令"
                  onClick={onReloadPasswords}
                >
                  <RefreshCw
                    size={13}
                    strokeWidth={2.2}
                    className={cn(passwordsLoading && 'weq-gap-spin')}
                  />
                  换一批
                </button>
              </div>
              {passwords.length > 0 ? (
                <div className={cn('redpacket-chips')} role="listbox" aria-label="候选口令">
                  {passwords.slice(0, 8).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className={cn('redpacket-chip', password === item && 'is-active')}
                      role="option"
                      aria-selected={password === item}
                      title={item}
                      onClick={() => setPassword(item)}
                    >
                      <Shuffle size={11} strokeWidth={2.2} aria-hidden />
                      {item}
                    </button>
                  ))}
                </div>
              ) : (
                <div className={cn('redpacket-password-empty')}>
                  <KeyRound size={13} strokeWidth={2.1} aria-hidden />
                  <span>没有取到候选口令，可以直接在右边封面上手写。</span>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* 右：封面即输入位 —— 祝福语 / 口令直接写在红包正中，改字即改封面。 */}
        <aside className={cn('redpacket-preview')} aria-label="红包预览">
          <div className={cn('redpacket-cover', passwordOn && 'is-password')}>
            <img className={cn('redpacket-cover-img')} src={coverSrc} alt="" draggable={false} />
            <span className={cn('redpacket-cover-kind')}>{meta.label}</span>
            <textarea
              className={cn('redpacket-cover-input')}
              placeholder={coverPlaceholder}
              maxLength={60}
              rows={1}
              value={coverText}
              ref={(node) => {
                coverRef.current = node;
                if (node) autoGrow(node);
              }}
              onChange={(event) => {
                autoGrow(event.currentTarget);
                if (passwordOn) setPassword(event.target.value);
                else setWishing(event.target.value);
              }}
              onFocus={(event) => autoGrow(event.currentTarget)}
              // 祝福语是封面上的一段字，不是多段文本：回车不当换行用。
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.preventDefault();
              }}
            />
          </div>
          <div className={cn('redpacket-preview-meta')}>
            <span className={cn('redpacket-preview-amount')}>
              ¥{formatFen(previewAmount > 0 ? previewAmount : 0)}
            </span>
            {group ? <span className={cn('redpacket-preview-count')}>{totalNum} 个</span> : null}
          </div>
          <p className={cn('redpacket-cover-hint')}>
            {passwordOn ? '口令就写在封面这行字里' : '封面上的字可以直接点着改'}
          </p>
        </aside>
      </div>

      <footer className={cn('redpacket-foot')}>
        <span
          className={cn('redpacket-hint', (problem || error) && !disabled && 'is-error')}
          title={error || undefined}
        >
          {disabled
            ? disabledHint
            : sending
              ? '下单中…'
              : problem || error || '下单后用手机 QQ 完成支付'}
        </span>
        <button
          type="button"
          className={cn('redpacket-btn', 'primary')}
          title={disabled ? disabledHint : problem || error || '发红包'}
          disabled={!canSend}
          onClick={() => void submit()}
        >
          <SendHorizontal size={13} strokeWidth={2.2} />
          发红包
        </button>
      </footer>
    </div>
  );
}
