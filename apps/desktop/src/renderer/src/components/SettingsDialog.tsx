/**
 * 设置弹窗。
 *
 * 左侧是分类导航，右侧是分类内容。外观能力单独收敛到“个性显示”页：
 * 基础模式、主题色（色相条 + 预设 + Hex）、界面背景、组件风格（占位）。
 */

import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  AudioLines,
  Check,
  Lock,
  Monitor,
  Moon,
  Palette,
  Plug,
  Settings2,
  Sun,
  User,
  X,
} from 'lucide-react';
import { GlobalSettingsSection } from './settings/GlobalSettingsSection';
import { AccountBasicsSection } from './settings/AccountBasicsSection';
import { VoiceTranscribeSection } from './settings/VoiceTranscribeSection';
import { McpServerSection } from './settings/McpServerSection';
import {
  useThemeStore,
  type ThemeBackground,
  type ThemeComponentStyle,
  type ThemePreference,
} from '../state/theme';

type SectionId = 'global' | 'appearance' | 'account' | 'voice' | 'mcp';

interface SettingsSection {
  id: SectionId;
  label: string;
  icon: ReactElement;
  render: () => ReactNode;
}

const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'global',
    label: '全局设置',
    icon: <Settings2 size={16} strokeWidth={1.8} />,
    render: () => <GlobalSettingsSection />,
  },
  {
    id: 'appearance',
    label: '个性显示',
    icon: <Palette size={16} strokeWidth={1.8} />,
    render: () => <AppearanceSection />,
  },
  {
    id: 'account',
    label: '账号基础',
    icon: <User size={16} strokeWidth={1.8} />,
    render: () => <AccountBasicsSection />,
  },
  {
    id: 'voice',
    label: '语音转录',
    icon: <AudioLines size={16} strokeWidth={1.8} />,
    render: () => <VoiceTranscribeSection />,
  },
  {
    id: 'mcp',
    label: 'MCP 服务器',
    icon: <Plug size={16} strokeWidth={1.8} />,
    render: () => <McpServerSection />,
  },
];

/** Quick-pick accent presets. First entry is the WeQ default blue. */
const ACCENT_PRESETS = [
  '#0099ff',
  '#3b82f6',
  '#6f8aa6',
  '#16b8a6',
  '#32b67a',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
];

const DEFAULT_ACCENT = '#0099ff';

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement | null {
  const [activeId, setActiveId] = useState<SectionId>('global');

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const active = SETTINGS_SECTIONS.find((s) => s.id === activeId) ?? SETTINGS_SECTIONS[0]!;

  return (
    <div className="weq-settings-layer" role="presentation" onMouseDown={onClose}>
      <section
        className="weq-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="weq-settings-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="weq-settings-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <nav className="weq-settings-nav" aria-label="设置分类">
          <h2 id="weq-settings-title" className="weq-settings-nav-title">
            设置
          </h2>
          <ul>
            {SETTINGS_SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`weq-settings-nav-item${s.id === activeId ? ' is-active' : ''}`}
                  onClick={() => setActiveId(s.id)}
                >
                  <span className="weq-settings-nav-icon">{s.icon}</span>
                  <span>{s.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="weq-settings-body">{active.render()}</div>
      </section>
    </div>
  );
}

function AppearanceSection(): ReactElement {
  const preference = useThemeStore((state) => state.preference);
  const accent = useThemeStore((state) => state.accent);
  const background = useThemeStore((state) => state.background);
  const componentStyle = useThemeStore((state) => state.componentStyle);
  const setPreference = useThemeStore((state) => state.setPreference);
  const setAccent = useThemeStore((state) => state.setAccent);
  const setBackground = useThemeStore((state) => state.setBackground);
  const setComponentStyle = useThemeStore((state) => state.setComponentStyle);

  return (
    <section className="weq-settings-section">
      <h3 className="weq-settings-section-title">个性显示</h3>
      <p>主题模式、主题色、界面背景与组件风格都在这里调整，改动即时生效。</p>

      <div className="weq-settings-appearance-card">
        <div className="weq-settings-appearance-head">
          <div>
            <strong>基础模式</strong>
            <span>控制浅色、深色与跟随系统</span>
          </div>
        </div>
        <ThemeModeSwitcher value={preference} onChange={setPreference} />
      </div>

      <div className="weq-settings-appearance-card">
        <div className="weq-settings-appearance-head">
          <div>
            <strong>主题色</strong>
            <span>拖动色相条或输入色值挑选主色，界面主色、描边与按钮都会跟随</span>
          </div>
        </div>
        <ColorPicker value={accent} onChange={setAccent} />
      </div>

      <div className="weq-settings-appearance-card">
        <div className="weq-settings-appearance-head">
          <div>
            <strong>界面背景</strong>
            <span>跟随主题色的柔光晕染，聊天、联系人与导出页统一生效</span>
          </div>
        </div>
        <ThemeBackgroundRow value={background} onChange={setBackground} />
      </div>

      <div className="weq-settings-appearance-card is-placeholder">
        <div className="weq-settings-appearance-head">
          <div>
            <strong>组件风格</strong>
            <span>切换整套组件皮肤，目前仅提供经典版</span>
          </div>
        </div>
        <ComponentStyleRow value={componentStyle} onChange={setComponentStyle} />
      </div>
    </section>
  );
}

function ThemeModeSwitcher({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}) {
  const options: Array<{ value: ThemePreference; label: string; icon: ReactNode }> = [
    { value: 'light', label: '浅色', icon: <Sun size={14} /> },
    { value: 'dark', label: '深色', icon: <Moon size={14} /> },
    { value: 'system', label: '跟随系统', icon: <Monitor size={14} /> },
  ];

  return (
    <div className="weq-settings-theme-switch-inner" role="radiogroup" aria-label="主题模式">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`weq-settings-theme-option${active ? ' is-active' : ''}`}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
          >
            <span className="weq-settings-theme-option-icon">{option.icon}</span>
            <span className="weq-settings-theme-option-label">{option.label}</span>
            {active ? <Check size={14} /> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────
 * 主题色调色器（色相条 + 明度条 + Hex 输入 + 预设快捷色）。
 * 主色存为自由 hex，空值回落到内置 --weq-accent。
 * ──────────────────────────────────────────────────────────────────── */

type Hsl = { h: number; s: number; l: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeHex(input: string): string | null {
  let hex = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

function hexToHsl(input: string): Hsl | null {
  const hex = normalizeHex(input);
  if (!hex) return null;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Track a horizontal drag on a bar; reports fraction 0..1 on down + move. */
function trackBar(
  event: ReactPointerEvent<HTMLDivElement>,
  onFraction: (fraction: number) => void,
): void {
  const rect = event.currentTarget.getBoundingClientRect();
  const compute = (clientX: number) => clamp01((clientX - rect.left) / rect.width);
  onFraction(compute(event.clientX));
  const move = (ev: PointerEvent) => onFraction(compute(ev.clientX));
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Lightness slider maps fraction 0..1 onto this readable band (avoids near
// black / near white accents that wash the UI out).
const LIGHT_MIN = 0.16;
const LIGHT_SPAN = 0.66;

function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}): ReactElement {
  const effective = value || DEFAULT_ACCENT;
  const hsl = hexToHsl(effective) ?? hexToHsl(DEFAULT_ACCENT)!;
  // Use a confident saturation when the hue strip drives the color so dragging
  // never produces a muddy accent; honor the picked saturation otherwise.
  const sat = Math.max(hsl.s, 0.5);

  const [hexDraft, setHexDraft] = useState(effective);
  useEffect(() => setHexDraft(effective), [effective]);

  const huePct = (hsl.h / 360) * 100;
  const lightFraction = clamp01((hsl.l - LIGHT_MIN) / LIGHT_SPAN);

  const pickHue = (fraction: number) =>
    onChange(hslToHex(fraction * 360, sat, hsl.l));
  const pickLight = (fraction: number) =>
    onChange(hslToHex(hsl.h, sat, LIGHT_MIN + fraction * LIGHT_SPAN));

  const lightGradient = `linear-gradient(to right, ${hslToHex(hsl.h, sat, LIGHT_MIN)}, ${hslToHex(
    hsl.h,
    sat,
    0.5,
  )}, ${hslToHex(hsl.h, sat, LIGHT_MIN + LIGHT_SPAN)})`;

  const commitHex = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) onChange(hex);
    else setHexDraft(effective);
  };

  return (
    <div className="weq-settings-colorpicker">
      <div className="weq-cp-preview" style={{ ['--weq-cp-color' as string]: effective }}>
        <span className="weq-cp-preview-dot" />
        <span className="weq-cp-preview-label">当前主色</span>
        <span className="weq-cp-preview-hex">{effective.toUpperCase()}</span>
      </div>

      <div
        className="weq-cp-bar weq-cp-hue"
        role="slider"
        aria-label="色相"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsl.h)}
        onPointerDown={(e) => trackBar(e, pickHue)}
      >
        <span className="weq-cp-thumb" style={{ left: `${huePct}%` }} />
      </div>

      <div
        className="weq-cp-bar weq-cp-light"
        role="slider"
        aria-label="明度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(lightFraction * 100)}
        style={{ background: lightGradient }}
        onPointerDown={(e) => trackBar(e, pickLight)}
      >
        <span className="weq-cp-thumb" style={{ left: `${lightFraction * 100}%` }} />
      </div>

      <div className="weq-cp-row">
        <label className="weq-cp-hex">
          <span>#</span>
          <input
            value={hexDraft.replace(/^#/, '')}
            spellCheck={false}
            maxLength={7}
            onChange={(e) => setHexDraft(e.target.value)}
            onBlur={(e) => commitHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitHex((e.target as HTMLInputElement).value);
            }}
            aria-label="主色十六进制值"
          />
        </label>
        <div className="weq-cp-presets" role="group" aria-label="预设主色">
          {ACCENT_PRESETS.map((swatch) => {
            const active = effective.toLowerCase() === swatch.toLowerCase();
            return (
              <button
                key={swatch}
                type="button"
                className={`weq-cp-swatch${active ? ' is-active' : ''}`}
                style={{ ['--weq-swatch-color' as string]: swatch }}
                onClick={() => onChange(swatch)}
                title={swatch}
                aria-label={swatch}
              >
                {active ? <Check size={12} /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ThemeBackgroundRow({
  value,
  onChange,
}: {
  value: ThemeBackground;
  onChange: (next: ThemeBackground) => void;
}) {
  const options: Array<{ value: ThemeBackground; label: string; desc: string }> = [
    { value: 'plain', label: '纯净', desc: '近纯色，最克制' },
    { value: 'tint', label: '柔光', desc: '单层主色晕染' },
    { value: 'mist', label: '弥散', desc: '多层叠加光晕' },
  ];

  return (
    <div className="weq-settings-preset-grid" role="radiogroup" aria-label="界面背景风格">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`weq-settings-preset-card${active ? ' is-active' : ''}`}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
          >
            <span
              className={`weq-settings-preset-preview is-bg-${option.value}`}
              aria-hidden="true"
            />
            <strong>{option.label}</strong>
            <small>{option.desc}</small>
          </button>
        );
      })}
    </div>
  );
}

function ComponentStyleRow({
  value,
  onChange,
}: {
  value: ThemeComponentStyle;
  onChange: (next: ThemeComponentStyle) => void;
}) {
  return (
    <div className="weq-settings-preset-grid" role="radiogroup" aria-label="组件风格">
      <button
        type="button"
        className={`weq-settings-preset-card${value === 'classic' ? ' is-active' : ''}`}
        role="radio"
        aria-checked={value === 'classic'}
        onClick={() => onChange('classic')}
      >
        <span className="weq-settings-preset-preview is-style-classic" aria-hidden="true" />
        <strong>经典</strong>
        <small>当前默认组件套</small>
      </button>
      <div
        className="weq-settings-preset-card is-locked"
        role="radio"
        aria-checked={false}
        aria-disabled="true"
      >
        <span className="weq-settings-preset-preview is-style-soon" aria-hidden="true">
          <Lock size={16} />
        </span>
        <strong>敬请期待</strong>
        <small>更多组件套规划中</small>
      </div>
    </div>
  );
}
