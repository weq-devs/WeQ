type Placeholder = { near: boolean; animationName: string };
type Registry = { add(element: HTMLElement): () => void };
const registries = new WeakMap<Document, Registry>();

function createRegistry(document: Document): Registry {
  const targets = new Map<HTMLElement, Placeholder>();
  const Observer = document.defaultView?.IntersectionObserver;
  const update = (element: HTMLElement, state: Placeholder) => {
    const name = state.near && document.visibilityState !== 'hidden' ? state.animationName : 'none';
    if (element.style.animationName !== name) element.style.animationName = name;
  };
  const observer = Observer
    ? new Observer(
        (entries) => {
          for (const entry of entries) {
            const element = entry.target as HTMLElement;
            const state = targets.get(element);
            if (!state) continue;
            state.near = entry.isIntersecting;
            update(element, state);
          }
        },
        { rootMargin: '200px' },
      )
    : null;
  const visibility = () => {
    for (const [element, state] of targets) update(element, state);
  };
  document.addEventListener('visibilitychange', visibility);
  const registry: Registry = {
    add(element) {
      const state = { near: !Observer, animationName: element.style.animationName };
      targets.set(element, state);
      // 不隐藏占位或图片；仅移除离屏闪光的 CSS 动画实例，避免上千个后台动画。
      update(element, state);
      observer?.observe(element);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        targets.delete(element);
        observer?.unobserve?.(element);
        element.style.animationName = state.animationName;
        if (targets.size) return;
        observer?.disconnect();
        document.removeEventListener('visibilitychange', visibility);
        registries.delete(document);
      };
    },
  };
  return registry;
}

/** React ref：同一文档共享观察器，不为每张待加载头像创建监听或 React 状态。 */
export function observePlaceholderAnimation(element: HTMLElement | null) {
  if (!element) return;
  const document = element.ownerDocument;
  let registry = registries.get(document);
  if (!registry) {
    registry = createRegistry(document);
    registries.set(document, registry);
  }
  return registry.add(element);
}
