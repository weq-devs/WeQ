import { create } from 'zustand';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ThemeResolved = 'light' | 'dark';
export type ThemeBackground = 'plain' | 'tint' | 'mist';
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
  return value === 'plain' || value === 'tint' || value === 'mist';
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
    return isThemeBackground(value) ? value : 'tint';
  } catch {
    return 'tint';
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
}

function persist(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: 'system',
  resolved: 'light',
  accent: '',
  background: 'tint',
  componentStyle: 'classic',
  initialized: false,
  setPreference: (preference) => {
    const { accent, background, componentStyle } = get();
    applyTheme({ preference, accent, background, componentStyle });
    persist(storageKeys.preference, preference);
    set({
      preference,
      resolved: resolvePreference(preference),
      initialized: true,
    });
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
