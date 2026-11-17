/**
 * 发红包下单后的**二维码灯箱**。
 *
 * `hb_pc_pre_pack` 只负责下单出码，不扣钱：真正付款由手机 QQ 用当前账号拉起支付页，
 * 这里的二维码是扫码回退。所以灯箱只做两件事 —— 展示二维码 + 给一句最短提示，不做
 * 乐观渲染（真实红包消息等 QQ 同步回来）。
 *
 * 命令式打开：`openRedBagQrcode(result)`，由 MainView 发红包成功后调用。
 */

import { create } from 'zustand';
import '../styles/redbag-dialog.css';

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

export const useRedBagQrcodeStore = create<RedBagQrcodeStore>((set) => ({
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
