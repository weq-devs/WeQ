/**
 * 年度报告的字体资源 —— 装扮字体的 face 注册 + 「主字体」全局换字。
 *
 * 两个用途共用同一份 face 注册表：
 *  - 装扮页要用每款字体各写一行预览字；
 *  - 用户选中最爱字体后，整份报告换成它。
 * 所以同一 itemId 只注册一次 face、只下载一次 ttf。
 *
 * 换字走注入受管 `<style>` 节点（与 lib/dressSkin.ts 同一套思路）：字体是纯外观，
 * 报告的每个页面组件都不该为它加一个 prop。字形先经 FontFace API 进
 * `document.fonts` 再落 CSS —— 声明式 `@font-face` 在注入那一刻还没下载完，会先用
 * 兜底字体排一遍、字体到了再排一遍，整页文字跳一下很显眼。
 *
 * **换的是排印令牌本身**（`--rp-serif` / `--rp-sans`），不是逐个类名去覆盖
 * `font-family`。后者试过，不работает：样式表里有七八处 `font-family: var(--rp-serif)
 * !important`（巨型年份、顶栏年号、里程表数字…），普通声明压不过去，而且每加一页新
 * 排印就要回来补一条选择器 —— 「之后加入的任何一页」根本跟不上。改令牌只有一条规则，
 * 所有引用 `var(--rp-serif)` 的地方（含带 `!important` 的）自动跟着换。
 *
 * 数字与等宽标签刻意**不换**：装扮字体多是子集化的手写体，缺西文数字字形会退化成
 * 兜底字，宽度不齐会让里程表逐位抖动。所以 `--rp-mono` 不动，`.weq-number` /
 * `.weq-od` 这类纯数字元素显式钉回原来的衬线栈（`--rp-serif-base` 存着原值）。
 *
 * 作用域限定在 `.weq-report-root` 内：报告换字不该波及应用其余部分。
 */

import { dressFontUrl } from '../../lib/resourceUrl';

const STYLE_ID = 'weq-report-font';

/** itemId → 该款是否成功注册过 face。null 表示正在加载。 */
const faces = new Map<number, Promise<boolean>>();

/** 报告内引用某款装扮字体的 CSS family 名。 */
export function reportFontFamily(itemId: number): string {
  return `weq-report-dress-${itemId}`;
}

/**
 * 确保某款装扮字体的 face 已注册进 `document.fonts`，返回是否可用。
 *
 * 失败（ttf 坏了 / 被 Chromium 的 OTS 拒了 / 本地没缓存又没在线实例）时返回 false
 * 而不抛 —— 调用方退回默认字形，报告界面不出任何提示。结果按 itemId 记忆，
 * 同一款不会重复下载，失败的也不会反复重试。
 */
export function ensureReportFontFace(itemId: number): Promise<boolean> {
  if (itemId <= 0) return Promise.resolve(false);
  let pending = faces.get(itemId);
  if (!pending) {
    pending = new FontFace(reportFontFamily(itemId), `url("${dressFontUrl(itemId)}")`)
      .load()
      .then((face) => {
        document.fonts.add(face);
        return true;
      })
      .catch(() => false);
    faces.set(itemId, pending);
  }
  return pending;
}

function removeStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

/**
 * 把某款装扮字体设为报告主字体。`itemId` 传 0 / null 表示恢复默认排印。
 *
 * 字体加载不成功时静默恢复默认。返回是否真的换成了，调用方据此决定要不要把
 * 选择记下来（以及要不要显示「已换」的状态）。
 */
export async function applyReportFont(itemId: number | null): Promise<boolean> {
  if (!itemId || itemId <= 0) {
    removeStyle();
    return false;
  }
  if (!(await ensureReportFontFace(itemId))) {
    removeStyle();
    return false;
  }

  const family = reportFontFamily(itemId);
  // 换令牌：一条规则换掉整份报告的正文 / 标题 / 引句，包括之后加入的任何一页。
  // 兜底栈保留原来的中西文衬线 —— 装扮字体缺哪个字，那个字还落在宋体上，不会变豆腐块。
  //
  // 第二条规则把纯数字元素钉回原生衬线栈：`--rp-serif-base` 是 CSS 里存的原值副本，
  // 这样即使 `--rp-serif` 已被上一条改掉，数字仍拿得到未换的那条栈。
  const css = `
.weq-report-root {
  --rp-serif: "${family}", "Playfair Display", Georgia, "Noto Serif CJK SC", "Noto Serif SC",
    "Source Han Serif SC", "Songti SC", SimSun, "Times New Roman", serif !important;
  --rp-sans: "${family}", var(--font-sans, ui-sans-serif, system-ui, sans-serif) !important;
}
.weq-report-root .weq-number,
.weq-report-root .weq-od,
.weq-report-root .weq-report-brand-year,
.weq-report-root .weq-ov-hero-num,
.weq-report-root .weq-entry-year-num,
.weq-report-root .weq-dress-hero-num {
  font-family: var(--rp-serif-base) !important;
}`;

  let node = document.getElementById(STYLE_ID);
  if (!node) {
    node = document.createElement('style');
    node.id = STYLE_ID;
    document.head.appendChild(node);
  }
  if (node.textContent !== css) node.textContent = css;
  return true;
}

/** 报告卸载时收干净：移掉换字样式（face 留在 document.fonts 里供下次复用）。 */
export function clearReportFont(): void {
  removeStyle();
}
