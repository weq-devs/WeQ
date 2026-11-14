interface ResizeCallbackTrace {
  observerId: number;
  sourceStack: string;
  targets: string[];
  at: number;
}

/** 开发诊断只读取已交付的尺寸，不调度回调、不额外测量 DOM。 */
export function traceDevelopmentResizeObservers(target: Window) {
  const view = target as Window & { ResizeObserver?: typeof ResizeObserver };
  const Original = view.ResizeObserver;
  const recent: ResizeCallbackTrace[] = [];
  let active = true;
  let nextId = 0;
  if (!Original) return { snapshot: () => [], dispose: () => {} };
  class TracedObserver extends Original {
    constructor(callback: ResizeObserverCallback) {
      if (typeof callback !== 'function') {
        super(callback);
        return;
      }
      const observerId = ++nextId;
      const sourceStack = new Error('ResizeObserver 创建位置').stack?.slice(0, 2400) ?? '';
      super((entries, observer) => {
        if (active) {
          try {
            recent.push({
              observerId,
              sourceStack,
              targets: entries.slice(0, 3).map(({ target, contentRect }) => {
                const classes = [...target.classList].slice(0, 3).join('.').slice(0, 120);
                return `${target.localName}${classes ? `.${classes}` : ''} ${contentRect.width}x${contentRect.height}`;
              }),
              at: view.performance.now(),
            });
            if (recent.length > 6) recent.shift();
          } catch {
            // 诊断失败不能改变浏览器原回调。
          }
        }
        callback.call(observer, entries, observer);
      });
    }
  }
  view.ResizeObserver = TracedObserver;
  return {
    snapshot: () => recent.filter(({ at }) => view.performance.now() - at < 100),
    dispose() {
      active = false;
      recent.length = 0;
      if (view.ResizeObserver === TracedObserver) view.ResizeObserver = Original;
    },
  };
}
