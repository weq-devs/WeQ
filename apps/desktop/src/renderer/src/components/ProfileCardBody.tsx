import { useLayoutEffect, useRef, type ReactNode } from 'react';

const fieldSelector = '.weq-profile-data-row, .weq-profile-section-head, .weq-contact-description';
const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';

type FieldPosition = { top: number; offset: number; animation?: Animation };

/** 名片正文独立滚动，字段变化时让后续行和卡片高度一起过渡。 */
export function ProfileCardBody({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    const view = body?.ownerDocument.defaultView;
    if (!body?.animate || !content || !view?.matchMedia || !view.ResizeObserver) return;

    const motion = view.matchMedia('(prefers-reduced-motion: no-preference)');
    let fields = new Map<Element, FieldPosition>();
    let width = 0;
    let height = 0;
    let resize: Animation | undefined;

    const update = () => {
      const bounds = content.getBoundingClientRect();
      const animate = motion.matches && bounds.width > 0 && bounds.width === width;
      const next = new Map<Element, FieldPosition>();
      const duration = bounds.height < height ? 160 : 210;

      // 先读自然位置，扣除上一段动画的位移。连续更新从眼前的位置接着走。
      for (const field of content.querySelectorAll(fieldSelector)) {
        if (!field.getClientRects().length) continue;
        const previous = fields.get(field);
        const progress = previous?.animation?.effect?.getComputedTiming().progress ?? 1;
        const shift = (previous?.offset ?? 0) * (1 - progress);
        const top = field.getBoundingClientRect().top - bounds.top - shift;
        const offset = previous ? previous.top + shift - top : 0;
        next.set(field, { top, offset });
      }

      if (!animate) resize?.cancel();
      else if (Math.abs(height - bounds.height) >= 1) {
        const style = view.getComputedStyle(body);
        const padding =
          Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
        const from = resize?.playState === 'running' ? style.height : `${height + padding}px`;
        resize?.cancel();
        resize = body.animate([{ height: from }, { height: `${bounds.height + padding}px` }], {
          duration,
          easing,
        });
      }

      for (const [field, position] of next) {
        const previous = fields.get(field);
        if (animate && previous && Math.abs(previous.top - position.top) < 1) {
          next.set(field, previous);
          continue;
        }
        previous?.animation?.cancel();
        if (animate && !previous) {
          position.animation = field.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration,
            easing,
          });
        } else if (animate && Math.abs(position.offset) >= 1) {
          position.animation = field.animate(
            [{ translate: `0 ${position.offset}px` }, { translate: '0 0' }],
            { duration, easing },
          );
        } else {
          position.offset = 0;
        }
      }
      for (const [field, previous] of fields) if (!next.has(field)) previous.animation?.cancel();
      fields = next;
      width = bounds.width;
      height = bounds.height;
    };

    update();
    const observer = new view.ResizeObserver(update);
    observer.observe(content);
    // 同高度的字段替换也可能让行移位，正文尺寸观察无法捕捉。
    const mutations = new view.MutationObserver(update);
    mutations.observe(content, { childList: true, subtree: true });
    motion.addEventListener('change', update);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      motion.removeEventListener('change', update);
      resize?.cancel();
      for (const { animation } of fields.values()) animation?.cancel();
    };
  }, []);

  return (
    <div className="weq-contact-card-body" ref={bodyRef}>
      <div className="weq-contact-card-content" ref={contentRef}>
        {children}
      </div>
    </div>
  );
}
