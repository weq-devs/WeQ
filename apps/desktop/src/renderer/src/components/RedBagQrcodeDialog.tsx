// @ts-nocheck
/**
 * 发红包下单后的**二维码灯箱**。
 *
 * `hb_pc_pre_pack` 只负责下单出码，不扣钱：真正付款由手机 QQ 用当前账号拉起支付页，
 * 这里的二维码是扫码回退。所以灯箱只做两件事 —— 展示二维码 + 给一句最短提示，不做
 * 乐观渲染（真实红包消息等 QQ 同步回来）。
 *
 * 命令式打开：`openRedBagQrcode(result)`，由 MainView 发红包成功后调用。
 */

import type { ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { ScanLine, X } from 'lucide-react';
import { useOverlayLayer } from '../lib/overlayStack';
import { useEscapeToClose } from '../im-template/template/modalUtils';

export interface RedBagQrcodeResult {
  /** 二维码 PNG 的 base64（不含 data URL 前缀）。 */
  qrcodeBase64: string;
  /** 是否拼手气（false = 等额）。 */
  lucky: boolean;
  /** 是否口令红包。 */
  password: boolean;
  /** 红包个数。 */
  totalNum: number;
  /** 总金额，单位分。 */
  totalAmount: number;
}

interface RedBagQrcodeStore {
  result: RedBagQrcodeResult | null;
  open(result: RedBagQrcodeResult): void;
  close(): void;
}

const useRedBagQrcodeStore = create<RedBagQrcodeStore>((set) => ({
  result: null,
  open(result) {
    set({ result });
  },
  close() {
    set({ result: null });
  },
}));

/** 命令式打开红包二维码灯箱。 */
export function openRedBagQrcode(result: RedBagQrcodeResult): void {
  useRedBagQrcodeStore.getState().open(result);
}

function formatAmount(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 灯箱角标上的完整类型名：等额普通 / 拼手气普通 / 等额口令 / 拼手气口令。 */
function kindName(result: RedBagQrcodeResult): string {
  if (result.password) return result.lucky ? '拼手气口令' : '等额口令';
  return result.lucky ? '拼手气普通' : '等额普通';
}

function RedBagQrcodeDialog({
  result,
  onClose,
}: {
  result: RedBagQrcodeResult;
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);
  const layer = useOverlayLayer(true);

  return createPortal(
    <div
      className="weq-redbag-qr-layer weq-anim-fade"
      style={layer ? { zIndex: layer } : undefined}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="weq-redbag-qr"
        role="dialog"
        aria-modal="true"
        aria-label="红包支付二维码"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="weq-redbag-qr-close" type="button" title="关闭" onClick={onClose}>
          <X size={18} />
        </button>

        <div className="weq-redbag-qr-badge">
          <ScanLine size={18} strokeWidth={2.1} />
          <span>{kindName(result)}</span>
        </div>

        <img
          className="weq-redbag-qr-img"
          src={`data:image/png;base64,${result.qrcodeBase64}`}
          alt="红包支付二维码"
          draggable={false}
        />

        <div className="weq-redbag-qr-meta">
          <span className="weq-redbag-qr-amount">¥{formatAmount(result.totalAmount)}</span>
          <span className="weq-redbag-qr-count">{result.totalNum} 个</span>
        </div>
        <p className="weq-redbag-qr-hint">用手机 QQ 完成支付</p>
      </section>
    </div>,
    document.body,
  );
}

/** 挂一次（放在 App 根部），渲染当前打开的红包二维码灯箱。 */
export function RedBagQrcodeHost(): ReactElement | null {
  const result = useRedBagQrcodeStore((s) => s.result);
  const close = useRedBagQrcodeStore((s) => s.close);
  if (!result) return null;
  return <RedBagQrcodeDialog result={result} onClose={close} />;
}
