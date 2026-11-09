/**
 * 记录最近一次输入方式（键盘 / 指针），供 CSS 决定是否显示焦点环。
 *
 * 文本输入框会一直匹配 `:focus-visible`，包括鼠标点击和代码里的 autoFocus；
 * 主输入框在打开会话时会被自动聚焦，如果无条件画焦点环，鼠标用户每次切会话
 * 都会看到一圈蓝框。这里只在用户真的用键盘（Tab）操作过之后才点亮焦点环。
 *
 * 只监听 document 上的一次性事件，不引入状态库；属性挂在 <html> 上，
 * 与主题/背景的 data-* 钩子一致。
 */
const ATTRIBUTE = 'data-weq-input-modality';

type Modality = 'keyboard' | 'pointer';

let installed = false;

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const root = document.documentElement;
  const set = (value: Modality) => root.setAttribute(ATTRIBUTE, value);
  set('pointer');
  document.addEventListener('pointerdown', () => set('pointer'), { capture: true, passive: true });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Tab') set('keyboard');
    },
    true,
  );
}

install();

/** 供测试或特殊入口手动同步（正常使用无需调用）。 */
export function setInputModality(value: Modality): void {
  if (typeof document !== 'undefined') document.documentElement.setAttribute(ATTRIBUTE, value);
}
