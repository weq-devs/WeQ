import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeResolved = 'light' | 'dark';
export type ThemeBackground = 'plain' | 'paper' | 'grid' | 'dots' | 'wash' | 'telegram';
/**
 * Component skin pack. Only `classic` ships today; the field exists so the
 * settings page can present a (placeholder) switcher and so future packs slot
 * in without another store migration. Nothing in CSS consumes it yet.
 */
export type ThemeComponentStyle = 'classic';

const storageKeys = {
  preference: 'weq.theme-preference',
  accent: 'weq.theme-accent',
  background: 'weq.theme-background',
  componentStyle: 'weq.theme-component-style',
} as const;

type ThemeState = {
  preference: ThemePreference;
  resolved: ThemeResolved;
  /** Free-form user accent (hex). Empty -> falls back to the preset --weq-accent. */
  accent: string;
  background: ThemeBackground;
  componentStyle: ThemeComponentStyle;
  initialized: boolean;
  setPreference: (preference: ThemePreference) => void;
  setAccent: (accent: string) => void;
  setBackground: (background: ThemeBackground) => void;
  setComponentStyle: (componentStyle: ThemeComponentStyle) => void;
  syncResolved: () => void;
  hydrate: () => void;
};

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isThemeBackground(value: string | null): value is ThemeBackground {
  return (
    value === 'plain' ||
    value === 'paper' ||
    value === 'grid' ||
    value === 'dots' ||
    value === 'wash' ||
    value === 'telegram'
  );
}

function isThemeComponentStyle(value: string | null): value is ThemeComponentStyle {
  return value === 'classic';
}

function readPreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(storageKeys.preference);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

function readAccent(): string {
  try {
    return window.localStorage.getItem(storageKeys.accent) || '';
  } catch {
    return '';
  }
}

function readBackground(): ThemeBackground {
  try {
    const value = window.localStorage.getItem(storageKeys.background);
    return isThemeBackground(value) ? value : 'paper';
  } catch {
    return 'paper';
  }
}

function readComponentStyle(): ThemeComponentStyle {
  try {
    const value = window.localStorage.getItem(storageKeys.componentStyle);
    return isThemeComponentStyle(value) ? value : 'classic';
  } catch {
    return 'classic';
  }
}

function resolvePreference(preference: ThemePreference): ThemeResolved {
  if (preference === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return preference;
}

function applyTheme({
  preference,
  accent,
  background,
  componentStyle,
}: {
  preference: ThemePreference;
  accent: string;
  background: ThemeBackground;
  componentStyle: ThemeComponentStyle;
}) {
  const resolved = resolvePreference(preference);
  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = resolved;
  root.dataset.background = background;
  root.dataset.componentStyle = componentStyle;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  root.style.setProperty('--weq-accent-custom', accent || '');
  // Keep the built-in QQ 频道 / QQ 空间 browsers' 深/浅 mode in lockstep with WeQ.
  // Safe when no such window is open; the bridge may be absent in non-electron
  // contexts (tests), hence the optional chaining.
  try {
    window.weq?.channel?.setTheme?.(preference);
    window.weq?.qzone?.setTheme?.(preference);
    // The 每日推文 ARK 封面 / 跳转页 render in the main process (no localStorage),
    // so push the effective accent + resolved 深/浅 for them to follow.
    window.weq?.weqAssistant?.setTheme?.({ accent, mode: resolved });
  } catch {}
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

/* ── 深浅模式切换的「扩散」动画 ────────────────────────────────────────
 * 用 View Transitions API 把切主题的那一帧冻结成新旧两张快照，再让新快照以
 * 点击点为圆心做圆形 clip-path 铺开（CSS 见 styles/index.css）。Chromium
 * 111+ 可用；不支持或用户开启「减少动态效果」时直接切，不留副作用。 */

const rippleClass = 'weq-theme-ripple';
/** 扩散时长按半径缩放，夹在这一区间内，近处不拖沓、远处不赶。 */
const rippleMinMs = 420;
const rippleMaxMs = 700;

/** 最近一次指针落点，作为扩散圆心；键盘触发等场景回落到视口中心。 */
let lastPointer: { x: number; y: number } | null = null;
let pointerTracked = false;
/** 递增序号：连续快切时只让最后一次的收尾清掉 ripple class。 */
let rippleSeq = 0;

function ensurePointerTracking() {
  if (pointerTracked) return;
  pointerTracked = true;
  window.addEventListener(
    'pointerdown',
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
}

function canRunThemeRipple(): boolean {
  const viewDocument = document as unknown as {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> };
  };
  if (typeof viewDocument.startViewTransition !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function runThemeRipple(commit: () => void) {
  const viewDocument = document as unknown as {
    startViewTransition: (callback: () => void) => { finished: Promise<void> };
  };
  const root = document.documentElement;
  const x = lastPointer?.x ?? window.innerWidth / 2;
  const y = lastPointer?.y ?? window.innerHeight / 2;
  // 半径取圆心到最远那个角的距离，否则边角会残留上一套主题。
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  const duration = Math.round(Math.min(rippleMaxMs, Math.max(rippleMinMs, radius * 0.32)));
  root.style.setProperty('--weq-theme-ripple-x', `${x}px`);
  root.style.setProperty('--weq-theme-ripple-y', `${y}px`);
  root.style.setProperty('--weq-theme-ripple-r', `${radius}px`);
  root.style.setProperty('--weq-theme-ripple-duration', `${duration}ms`);
  root.classList.add(rippleClass);
  const seq = ++rippleSeq;
  try {
    const transition = viewDocument.startViewTransition(commit);
    transition.finished
      .catch(() => {})
      .then(() => {
        if (seq === rippleSeq) root.classList.remove(rippleClass);
      });
  } catch {
    if (seq === rippleSeq) root.classList.remove(rippleClass);
    commit();
  }
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: 'system',
  resolved: 'light',
  accent: '',
  background: 'paper',
  componentStyle: 'classic',
  initialized: false,
  setPreference: (preference) => {
    const { accent, background, componentStyle, resolved } = get();
    const commit = () => {
      applyTheme({ preference, accent, background, componentStyle });
      persist(storageKeys.preference, preference);
      set({
        preference,
        resolved: resolvePreference(preference),
        initialized: true,
      });
    };
    // 只有明暗真的变了才值得播动画；选「跟随系统」而结果不变时安静地记下偏好。
    if (resolvePreference(preference) === resolved || !canRunThemeRipple()) {
      commit();
      return;
    }
    runThemeRipple(commit);
  },
  setAccent: (accent) => {
    const { preference, background, componentStyle } = get();
    applyTheme({ preference, accent, background, componentStyle });
    persist(storageKeys.accent, accent);
    set({ accent, initialized: true });
  },
  setBackground: (background) => {
    const { preference, accent, componentStyle } = get();
    applyTheme({ preference, accent, background, componentStyle });
    persist(storageKeys.background, background);
    set({ background, initialized: true });
  },
  setComponentStyle: (componentStyle) => {
    const { preference, accent, background } = get();
    applyTheme({ preference, accent, background, componentStyle });
    persist(storageKeys.componentStyle, componentStyle);
    set({ componentStyle, initialized: true });
  },
  syncResolved: () => {
    const { preference, accent, background, componentStyle } = get();
    const resolved = resolvePreference(preference);
    applyTheme({ preference, accent, background, componentStyle });
    set({ resolved });
  },
  hydrate: () => {
    const preference = readPreference();
    const accent = readAccent();
    const background = readBackground();
    const componentStyle = readComponentStyle();
    applyTheme({ preference, accent, background, componentStyle });
    persist(storageKeys.preference, preference);
    persist(storageKeys.accent, accent);
    persist(storageKeys.background, background);
    persist(storageKeys.componentStyle, componentStyle);
    set({
      preference,
      resolved: resolvePreference(preference),
      accent,
      background,
      componentStyle,
      initialized: true,
    });
  },
}));

let systemCleanup: (() => void) | null = null;
let hydrated = false;

function setupSystemListener(onChange: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => onChange();
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}

export function ensureThemeInitialized() {
  if (hydrated) return;
  hydrated = true;

  ensurePointerTracking();

  const store = useThemeStore.getState();
  store.hydrate();

  if (systemCleanup) {
    systemCleanup();
    systemCleanup = null;
  }

  systemCleanup = setupSystemListener(() => {
    const current = useThemeStore.getState();
    if (current.preference !== 'system') return;
    current.syncResolved();
  });
}
