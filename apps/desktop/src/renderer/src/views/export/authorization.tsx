import { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { client } from '../../trpc/client';
import { AuthorizationForm, cancelAuthorizationRequest } from '../../components/RestrictedMode';
import { OverlayLayer } from '../../components/OverlayLayer';
import { useRestrictedMode } from '../../state/restrictedMode';
import type { OnlineAccess } from '../../lib/restrictedMode';
import type { ExportOptions } from './types';
import { useToast } from '../../components/Toast';

export interface ExportAuthorizationState {
  access: OnlineAccess & { needsMemoryRead?: boolean };
  capture: { available: boolean; elevated: boolean; hint?: string };
  armed: boolean;
}
export type ExportAuthorizationIndicatorState = { needed: boolean; request: () => void };

export function exportAuthorizationPlan(options: ExportOptions, state: ExportAuthorizationState) {
  const capture = options.transcribeVoice && options.onlineTranscribe && !state.armed;
  const online = state.access.qqOnline && state.access.attachEnabled;
  const credentials = state.access.hasA2 && state.access.hasD2 && state.access.hasD2Key;
  const memory = online && (state.access.needsMemoryRead ?? !credentials);
  const unready = memory || (online && !state.access.hasGuid);
  const roaming = unready && options.completeMessages;
  const ocr = unready && options.ocrImages && options.onlineOcr;
  const media =
    unready &&
    options.exportMedia &&
    (options.completeMedia || options.downloadVideo || options.downloadFile || options.downloadPtt);
  const elevate = (capture || (memory && (roaming || ocr || media))) && !state.capture.elevated;
  return { capture, roaming, ocr, media, elevate, needed: capture || roaming || ocr || media };
}

export function skipExportAuthorization(
  options: ExportOptions,
  plan: ReturnType<typeof exportAuthorizationPlan>,
): ExportOptions {
  return {
    ...structuredClone(options),
    ...(plan.capture ? { onlineTranscribe: false } : {}),
    ...(plan.roaming ? { completeMessages: false } : {}),
    ...(plan.ocr ? { onlineOcr: false, ocrImages: false } : {}),
    ...(plan.media
      ? { completeMedia: false, downloadVideo: false, downloadFile: false, downloadPtt: false }
      : {}),
  };
}

async function readReadiness(captureNeeded = false): Promise<ExportAuthorizationState> {
  const [access, capture, status] = await Promise.all([
    client.account.getGroupAlbumAccessState.query(),
    client.wonderfulTools.captureSupport.query(),
    captureNeeded ? client.account.onlineTranscribeStatus.query() : { armed: false },
  ]);
  return { access, capture, armed: status.armed };
}

export function useExportAuthorization(options: ExportOptions, enabled: boolean) {
  const [state, setState] = useState<ExportAuthorizationState>();
  const [pending, setPending] = useState<{
    options: ExportOptions;
    state: ExportAuthorizationState;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resolve = useRef<((options: ExportOptions | null) => void) | undefined>(undefined);
  const known = useRef(new Set<string>());
  const cancelled = useRef(false);
  const alive = useRef(true);
  const operationActive = useRef(false);
  const ownsCapture = useRef(false);
  const releaseCapture = useCallback(async () => {
    if (!ownsCapture.current) return;
    ownsCapture.current = false;
    await client.account.onlineTranscribeDisarm.mutate();
  }, []);
  const preparing = useRef(false);
  const captureNeeded = options.transcribeVoice && options.onlineTranscribe;
  const requests = useRestrictedMode((s) => s.requests);
  useEffect(() => {
    if (!captureNeeded) void releaseCapture().catch(() => {});
  }, [captureNeeded, releaseCapture]);
  const owned = useCallback(
    () =>
      useRestrictedMode
        .getState()
        .requests.filter((r) => !known.current.has(`${r.kind}:${r.token}`)),
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const refresh = () => {
      void readReadiness(captureNeeded)
        .then((value) => {
          if (!disposed) setState(value);
        })
        .catch(() => {});
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [enabled, captureNeeded]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancelled.current = true;
      void releaseCapture().catch(() => {});
      if (operationActive.current)
        for (const request of owned()) cancelAuthorizationRequest(request);
      if (resolve.current) {
        resolve.current(null);
        resolve.current = undefined;
      }
    };
  }, [owned, releaseCapture]);
  function settle(value: ExportOptions | null) {
    cancelled.current = true;
    if (!value?.onlineTranscribe) void releaseCapture().catch(() => {});
    if (busy) for (const request of owned()) cancelAuthorizationRequest(request);
    const done = resolve.current;
    resolve.current = undefined;
    setPending(undefined);
    done?.(value);
  }
  async function prepare(value: ExportOptions): Promise<ExportOptions | null> {
    if (!enabled) return value;
    if (
      !value.completeMessages &&
      !(value.transcribeVoice && value.onlineTranscribe) &&
      !(value.ocrImages && value.onlineOcr) &&
      !(
        value.exportMedia &&
        (value.completeMedia || value.downloadVideo || value.downloadFile || value.downloadPtt)
      )
    )
      return value;
    if (resolve.current || busy || preparing.current) return null;
    preparing.current = true;
    try {
      const current = await readReadiness(value.transcribeVoice && value.onlineTranscribe);
      if (!alive.current) return null;
      setState(current);
      if (!exportAuthorizationPlan(value, current).needed) return value;
      known.current = new Set(
        useRestrictedMode.getState().requests.map((r) => `${r.kind}:${r.token}`),
      );
      setError('');
      setPending({ options: structuredClone(value), state: current });
      return await new Promise<ExportOptions | null>((done) => {
        resolve.current = done;
      });
    } catch (e) {
      useToast.getState().push({ tone: 'error', title: '检查导出授权失败', detail: String(e) });
      return null;
    } finally {
      preparing.current = false;
    }
  }
  async function authorize() {
    if (!pending || busy) return;
    const snapshot = pending;
    const plan = exportAuthorizationPlan(snapshot.options, snapshot.state);
    cancelled.current = false;
    operationActive.current = true;
    setBusy(true);
    setError('');
    const unsubscribe = useRestrictedMode.subscribe(() => {
      if (cancelled.current || !alive.current)
        for (const request of owned()) cancelAuthorizationRequest(request);
    });
    try {
      if (plan.roaming || plan.ocr || plan.media) {
        await client.account.refreshRkeys.mutate();
        if (cancelled.current || !alive.current) return;
        const refreshed = await readReadiness(plan.capture);
        const next = exportAuthorizationPlan(snapshot.options, refreshed);
        if (next.roaming || next.ocr || next.media)
          throw new Error('在线凭据仍未就绪，请检查授权与 QQ 登录状态，或跳过需提权项目。');
      }
      if (plan.capture) {
        const current = await readReadiness(true);
        if (cancelled.current || !alive.current) return;
        if (!current.capture.available) throw new Error(current.capture.hint || '抓包后端不可用。');
        if (!current.armed) {
          await client.account.onlineTranscribeArm.mutate({});
          ownsCapture.current = true;
        }
        if (cancelled.current || !alive.current) {
          await releaseCapture();
          return;
        }
      }
      const refreshed = await readReadiness(plan.capture);
      if (cancelled.current || !alive.current) return;
      setState(refreshed);
      settle(snapshot.options);
    } catch (e) {
      if (!cancelled.current && alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      operationActive.current = false;
      unsubscribe();
      if (alive.current) setBusy(false);
    }
  }
  const plan = state ? exportAuthorizationPlan(options, state) : undefined;
  const pendingPlan = pending ? exportAuthorizationPlan(pending.options, pending.state) : undefined;
  return {
    needsElevation: Boolean(plan?.elevate),
    armed: state?.armed ?? false,
    busy,
    prepare,
    releaseCapture,
    commit: (value: ExportOptions) => {
      if (value.transcribeVoice && value.onlineTranscribe) ownsCapture.current = false;
      else void releaseCapture().catch(() => {});
    },
    dialog:
      pending && pendingPlan ? (
        <OverlayLayer onClose={() => settle(null)}>
          <div className="modal-scrim weq-export-auth-scrim">
            <section
              role="dialog"
              aria-modal="true"
              aria-label={pendingPlan.elevate ? '需要提权' : '准备在线功能'}
              className="weq-export-authorization"
            >
              <header>
                <strong>
                  <ShieldAlert size={17} />
                  {pendingPlan.elevate ? '需要提权' : '准备在线功能'}
                </strong>
                <button
                  type="button"
                  className="weq-exp-tool"
                  title="返回导出配置"
                  aria-label="返回导出配置"
                  onClick={() => settle(null)}
                >
                  <X size={16} />
                </button>
              </header>
              <ul>
                {pendingPlan.capture ? <li>官方语音转写抓包</li> : null}
                {pendingPlan.roaming ? <li>拉取漫游消息</li> : null}
                {pendingPlan.ocr ? <li>官方图片识别</li> : null}
                {pendingPlan.media ? <li>在线媒体补全</li> : null}
              </ul>
              {requests
                .filter(() => busy)
                .map((request) => (
                  <AuthorizationForm key={`${request.kind}:${request.token}`} request={request} />
                ))}
              {error ? <p role="alert">{error}</p> : null}
              <footer>
                <button
                  type="button"
                  className="weq-exp-btn"
                  onClick={() => settle(skipExportAuthorization(pending.options, pendingPlan))}
                >
                  跳过需提权项目
                </button>
                <button
                  type="button"
                  className="weq-exp-btn is-primary"
                  disabled={busy}
                  onClick={() => void authorize()}
                >
                  {busy ? '等待授权' : pendingPlan.elevate ? '提权并继续' : '启用并继续'}
                </button>
              </footer>
            </section>
          </div>
        </OverlayLayer>
      ) : null,
  };
}
