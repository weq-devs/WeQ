export const mobileRootTabs = ['messages', 'contacts', 'qzone', 'more'] as const;
export type MobileRootTab = (typeof mobileRootTabs)[number];

export function mobileRootTab(value: string | undefined | null): MobileRootTab | undefined {
  return mobileRootTabs.find((tab) => tab === value);
}

/** 过渡副本不可交互；保留列表坐标与输入值，不复制监听器或触发业务挂载。 */
function copyPage(source: HTMLElement) {
  const copy = source.cloneNode(true) as HTMLElement;
  const originals = [source, ...source.querySelectorAll<HTMLElement>('*')];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  const scrolls = originals.map((node, index) => ({
    node: copies[index]!,
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
  originals.forEach((node, index) => {
    const target = copies[index]!;
    target.removeAttribute('id');
    if (node instanceof HTMLInputElement && target instanceof HTMLInputElement) {
      target.value = node.value;
      target.checked = node.checked;
    }
    if (node instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement)
      target.value = node.value;
  });
  return {
    copy,
    restore: () => {
      for (const { node, top, left } of scrolls) {
        node.scrollTop = top;
        node.scrollLeft = left;
      }
    },
  };
}

function pageSource(root: HTMLElement, tab: MobileRootTab, current: boolean) {
  if (current) {
    const selector =
      tab === 'more'
        ? '.weq-mobile-navigation > .weq-mobile-more'
        : tab === 'qzone'
          ? '.app-shell > .chat-main'
          : '.app-shell > .sidebar';
    return root.querySelector<HTMLElement>(selector);
  }
  return root.querySelector<HTMLElement>(`[data-mobile-root-preview="${tab}"] > *`);
}

function copySidebar(source: HTMLElement, list: HTMLElement) {
  const copy = source.cloneNode(false) as HTMLElement;
  const restores: Array<() => void> = [];
  for (const child of source.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.classList.contains('sidebar-body')) {
      const body = child.cloneNode(false) as HTMLElement;
      const page = copyPage(list);
      page.copy.hidden = false;
      page.copy.style.display = 'flex';
      body.append(page.copy);
      copy.append(body);
      restores.push(page.restore);
    } else {
      const header = copyPage(child);
      copy.append(header.copy);
      restores.push(header.restore);
    }
  }
  return {
    copy,
    restore: () => {
      for (const restore of restores) restore();
    },
  };
}

export function createMobileRootTransition(
  root: HTMLElement,
  from: MobileRootTab,
  to: MobileRootTab,
  reduced: boolean,
) {
  const source = pageSource(root, from, true);
  const destination = pageSource(root, to, false);
  if (!source || !destination) return undefined;
  const makePage = (page: HTMLElement, tab: MobileRootTab) => {
    if (tab !== 'messages' && tab !== 'contacts') return copyPage(page);
    const list = root.querySelector<HTMLElement>(`[data-mobile-sidebar-page="${tab}"]`);
    return list ? copySidebar(page, list) : undefined;
  };
  const oldPage = makePage(source, from);
  const newPage = makePage(destination, to);
  if (!oldPage || !newPage) return undefined;
  const layer = document.createElement('div');
  layer.className = 'weq-mobile-transition';
  layer.inert = true;
  layer.setAttribute('aria-hidden', 'true');
  const outgoing = document.createElement('div');
  const incoming = document.createElement('div');
  outgoing.dataset.mobileTransitionPage = from;
  incoming.dataset.mobileTransitionPage = to;
  outgoing.append(oldPage.copy);
  incoming.append(newPage.copy);
  layer.append(outgoing, incoming);
  root.append(layer);
  oldPage.restore();
  newPage.restore();
  const direction = mobileRootTabs.indexOf(to) > mobileRootTabs.indexOf(from) ? 1 : -1;
  const width = root.clientWidth;
  const offset = (distance: number) =>
    reduced
      ? [
          { opacity: 1 - Math.abs(distance) / Math.max(width, 1) },
          { opacity: Math.abs(distance) / Math.max(width, 1) },
        ]
      : [
          { transform: `translate3d(${distance}px,0,0)` },
          { transform: `translate3d(${distance + direction * width}px,0,0)` },
        ];
  const move = (distance: number) => {
    const [oldStyle, newStyle] = offset(distance);
    Object.assign(outgoing.style, oldStyle);
    Object.assign(incoming.style, newStyle);
  };
  move(0);
  return {
    to,
    move,
    destroy: () => layer.remove(),
    finish: async (distance: number, accepted: boolean) => {
      const end = accepted ? -direction * width : 0;
      const startFrames = offset(distance);
      const endFrames = offset(end);
      const animations = [outgoing, incoming].map((page, index) =>
        page.animate?.([startFrames[index]!, endFrames[index]!], {
          duration: reduced ? 100 : 200,
          easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        }),
      );
      move(end);
      await Promise.all(animations.map((animation) => animation?.finished.catch(() => {})));
    },
  };
}
