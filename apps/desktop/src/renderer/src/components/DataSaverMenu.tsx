import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { CloudDownload, Clock, LoaderCircle, Power, RotateCcw, Settings, X } from 'lucide-react';
import type { DataSaverMode, DataSaverTemporary } from '@weq/service/data-saver';
import { changePreference, preferenceValue, useClientPreferences } from '../lib/clientPreferences';
import {
  clearTemporaryDataSaver,
  DATA_SAVER_MENU_EVENT,
  dataSaverModeOptions,
  refreshDataSaverStatus,
  temporarilySetDataSaver,
  useDataSaver,
} from '../lib/dataSaver';
import { requestOpenSettings } from '../lib/callSettingsBridge';
import { useOverlayLayer } from '../lib/overlayStack';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import { SegmentedControl } from './SegmentedControl';
import { Toggle } from './settings/controls';
import '../styles/data-saver-menu.css';

function temporaryLabel(value: DataSaverTemporary) {
  const mode = value.enabled ? '临时开启' : '临时关闭';
  if (value.duration === 'tasks') return `${mode} · 直到全部任务完成`;
  if (value.duration === 'exit') return `${mode} · 直到 WeQ 退出`;
  const minutes = Math.max(0, Math.ceil(((value.expiresAt ?? Date.now()) - Date.now()) / 60000));
  return `${mode} · 剩余 ${minutes} 分钟`;
}

export function DataSaverMenu() {
  const { enabled, host, local, status } = useDataSaver();
  const preferences = useClientPreferences();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<boolean | null>(null);
  const [duration, setDuration] = useState<'tasks' | 'exit' | 'minutes'>('exit');
  const [minutes, setMinutes] = useState('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [, tick] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const titleId = useId();
  const layer = useOverlayLayer(open);
  const visible =
    enabled ||
    host.state === 'restricted' ||
    local.state === 'restricted' ||
    Boolean(status?.temporary);
  const close = useCallback(() => {
    setOpen(false);
    setTarget(null);
    setError('');
  }, []);
  useSurfaceEscapeDismissal(panel, close, open);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const show = (event: Event) => {
      const parent = root.current?.parentElement;
      if (
        parent?.getClientRects().length &&
        !root.current?.closest('[hidden], [inert], [aria-hidden="true"]') &&
        getComputedStyle(parent).visibility !== 'hidden'
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener(DATA_SAVER_MENU_EVENT, show);
    return () => window.removeEventListener(DATA_SAVER_MENU_EVENT, show);
  }, []);
  useEffect(() => {
    if (!open) return;
    void refreshDataSaverStatus().catch((value) => {
      if (mounted.current) setError(`读取省流量状态失败：${String(value)}`);
    });
    const timer = setInterval(() => tick((value) => value + 1), 15000);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !root.current?.contains(event.target) &&
        !panel.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      clearInterval(timer);
      document.removeEventListener('pointerdown', outside);
    };
  }, [open, close]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(360, window.innerWidth - 16);
      const viewport = window.visualViewport;
      setPosition({
        width,
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: rect.bottom + 6,
        maxHeight: Math.max(
          0,
          (viewport?.height ?? innerHeight) + (viewport?.offsetTop ?? 0) - rect.bottom - 14,
        ),
      });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open]);
  const perform = async (work: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
      if (mounted.current) setTarget(null);
    } catch (value) {
      if (mounted.current) setError(value instanceof Error ? value.message : String(value));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const validMinutes = /^\d+$/.test(minutes) && Number(minutes) >= 1 && Number(minutes) <= 1440;
  const title = status?.temporary
    ? temporaryLabel(status.temporary)
    : enabled
      ? '省流量模式已开启'
      : '省流量模式已关闭';
  return (
    <div ref={root} className="weq-data-saver-entry">
      <button
        ref={trigger}
        type="button"
        className={`weq-data-saver-indicator${enabled ? ' is-active' : ''}`}
        hidden={!visible && !open}
        title={title}
        aria-label="省流量菜单"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <CloudDownload size={15} aria-hidden />
      </button>
      {open
        ? createPortal(
            <section
              ref={panel}
              className="weq-data-saver-panel"
              role="dialog"
              aria-modal="false"
              aria-labelledby={titleId}
              style={{ ...position, zIndex: layer }}
            >
              <header>
                <h2 id={titleId}>
                  <CloudDownload size={17} aria-hidden />
                  省流量模式
                </h2>
                <button
                  type="button"
                  className="weq-set-iconbtn"
                  title="关闭省流量菜单"
                  aria-label="关闭省流量菜单"
                  onClick={close}
                >
                  <X size={16} aria-hidden />
                </button>
              </header>
              <div className="weq-data-saver-menu-body">
                <p role="status">
                  {enabled ? '正在节省流量' : '正常加载'}
                  {status?.temporary ? ` · ${temporaryLabel(status.temporary)}` : ''}
                </p>
                <div className="weq-data-saver-menu-field">
                  <span>基础设置</span>
                  <SegmentedControl<DataSaverMode>
                    label="省流量基础设置"
                    value={status?.mode ?? preferenceValue('dataSaverMode')}
                    options={dataSaverModeOptions}
                    disabled={busy || !status}
                    onChange={(mode) =>
                      void perform(async () => {
                        if (!(await changePreference('dataSaverMode', mode)))
                          throw new Error(
                            useClientPreferences.getState().error || '省流量设置未保存，请重试',
                          );
                        await refreshDataSaverStatus();
                      })
                    }
                  />
                </div>
                {(status?.mode ?? preferenceValue('dataSaverMode')) === 'auto' ? (
                  <div className="weq-data-saver-menu-metered">
                    <span>使用流量时自动启用</span>
                    <Toggle
                      label="使用流量时自动启用"
                      checked={preferenceValue('dataSaverOnMetered')}
                      disabled={busy || !status}
                      onChange={(value) =>
                        void perform(async () => {
                          if (!(await changePreference('dataSaverOnMetered', value)))
                            throw new Error(
                              useClientPreferences.getState().error || '省流量设置未保存，请重试',
                            );
                          await refreshDataSaverStatus();
                        })
                      }
                    />
                  </div>
                ) : null}
                <div className="weq-data-saver-menu-actions">
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    disabled={busy || !status}
                    onClick={() => {
                      setTarget(!enabled);
                      setDuration('exit');
                      setError('');
                    }}
                  >
                    <Power size={14} aria-hidden />
                    {enabled ? '临时关闭' : '临时开启'}
                  </button>
                  {status?.temporary ? (
                    <button
                      type="button"
                      className="weq-set-btn weq-set-btn-soft"
                      disabled={busy}
                      onClick={() => void perform(clearTemporaryDataSaver)}
                    >
                      <RotateCcw size={14} aria-hidden />
                      恢复基础设置
                    </button>
                  ) : null}
                </div>
                {target !== null ? (
                  <div className="weq-data-saver-duration">
                    <SegmentedControl<'tasks' | 'exit' | 'minutes'>
                      label="临时省流量期限"
                      value={duration}
                      disabled={busy}
                      options={[
                        {
                          value: 'tasks',
                          label: '直到全部任务完成',
                          hidden: target,
                          disabled: status?.pendingTasks === null || !status?.pendingTasks,
                          title:
                            status?.pendingTasks === null
                              ? '任务状态尚未确认'
                              : !status?.pendingTasks
                                ? '暂无未完成任务'
                                : undefined,
                        },
                        { value: 'exit', label: '直到 WeQ 退出' },
                        { value: 'minutes', label: '自定义分钟数' },
                      ]}
                      onChange={setDuration}
                    />
                    {duration === 'minutes' ? (
                      <label className="weq-data-saver-minutes">
                        <input
                          className="weq-set-input"
                          type="number"
                          aria-label="临时省流量分钟数"
                          min={1}
                          max={1440}
                          step={1}
                          value={minutes}
                          disabled={busy}
                          onChange={(event) => setMinutes(event.target.value)}
                        />
                        <span>分钟</span>
                      </label>
                    ) : null}
                    <button
                      type="button"
                      className="weq-set-btn"
                      disabled={
                        busy ||
                        (duration === 'minutes' && !validMinutes) ||
                        (duration === 'tasks' && !status?.pendingTasks)
                      }
                      onClick={() =>
                        void perform(() =>
                          temporarilySetDataSaver(
                            duration === 'minutes'
                              ? { enabled: target, duration, minutes: Number(minutes) }
                              : duration === 'tasks'
                                ? { enabled: false, duration }
                                : { enabled: target, duration },
                          ),
                        )
                      }
                    >
                      {busy ? (
                        <LoaderCircle size={14} className="weq-data-saver-progress" aria-hidden />
                      ) : (
                        <Clock size={14} aria-hidden />
                      )}
                      {target ? '确认临时开启' : '确认临时关闭'}
                    </button>
                  </div>
                ) : null}
                {error || preferences.error ? (
                  <p role="alert">{error || preferences.error}</p>
                ) : null}
                <footer>
                  <button
                    type="button"
                    className="weq-set-btn weq-set-btn-soft"
                    onClick={() => {
                      close();
                      requestOpenSettings('dataSaver');
                    }}
                  >
                    <Settings size={14} aria-hidden />
                    完整设置
                  </button>
                </footer>
              </div>
            </section>,
            document.body,
          )
        : null}
    </div>
  );
}
