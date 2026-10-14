/**
 * 意图感知设置面板 —— 「更多 → 意图感知」打开。
 *
 * 内容：
 *   • 总开关（乐观写：服务层落盘后立即返回期望状态，直接写查询缓存）。
 *   • 引擎选择：API（复用 agentlab provider，下拉选 provider + 模型）或
 *     本地模型（Laya 多语言 ONNX，~600MB 按需下载，支持 hf-mirror 镜像；
 *     下载完成可拉起 worker —— 状态实时反映在 localAvailable/engineReady）。
 *   • 回复建议开关（仅 API 引擎可用 —— Laya 是决策模型不生成文本）。
 *
 * 会话粒度的开关在「会话设置」里（ConversationSettingsDialog），这里只管全局。
 */

import { useState, type ReactElement } from 'react';
import { BrainCircuit, Download, Play, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog';
import { Card, Row, SectionHeader, Toggle } from './settings/controls';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

interface ProviderModelWire {
  id: string;
  label?: string;
  capabilities?: string[];
}

interface ProviderWire {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModelWire[];
}

interface StatusWire {
  enabled: boolean;
  engine: 'api' | 'local';
  providerRef: { providerId: string; model: string } | null;
  suggestionsEnabled: boolean;
  hfMirror: boolean;
  apiConfigured: boolean;
  localAvailable: boolean;
}

interface LocalEngineWire {
  available: boolean;
  modelDownloaded: boolean;
  engineReady: boolean;
  modelDir: string;
  downloading: boolean;
}

interface DownloadProgressWire {
  filesDone: number;
  filesTotal: number;
  received: number;
  total: number;
  currentFile: string | null;
  done: boolean;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

export function IntentSenseSettingsDialog({ onClose }: { onClose: () => void }): ReactElement {
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();

  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const localEngine = trpc.account.intentSense.getLocalEngine.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
    // 引擎状态会因下载/启动变化，订阅进度时顺手刷新。
  });
  const [progress, setProgress] = useState<DownloadProgressWire | null>(null);

  trpc.account.intentSense.onModelDownloadProgress.useSubscription(undefined, {
    onData: (p) => {
      setProgress(p as DownloadProgressWire);
      if ((p as DownloadProgressWire).done) {
        void utils.account.intentSense.getLocalEngine.invalidate();
      }
    },
    onError: () => undefined,
  });

  const setConfig = trpc.account.intentSense.setConfig.useMutation();
  const downloadModel = trpc.account.intentSense.downloadLocalModel.useMutation();
  const startEngine = trpc.account.intentSense.startLocalEngine.useMutation();

  useEscapeToClose(onClose);

  const s = status.data as StatusWire | undefined;
  const providers = ((settings.data?.agentLab?.providers ?? []) as ProviderWire[]).filter(
    (p) => p.models.length > 0,
  );
  const local = localEngine.data as LocalEngineWire | undefined;

  type ConfigPatch = Parameters<typeof setConfig.mutateAsync>[0];

  async function patch(input: ConfigPatch): Promise<void> {
    try {
      const next = await setConfig.mutateAsync(input);
      utils.account.intentSense.getStatus.setData(undefined, next);
    } catch (e) {
      showError('意图感知设置失败', e instanceof Error ? e.message : String(e));
      void status.refetch();
    }
  }

  async function onDownload(): Promise<void> {
    const res = await downloadModel.mutateAsync({ mirror: s?.hfMirror !== false });
    if (!res.ok) {
      showError('模型下载失败', res.error ?? '');
    }
    void utils.account.intentSense.getLocalEngine.invalidate();
  }

  async function onStart(): Promise<void> {
    const res = await startEngine.mutateAsync();
    if (!res.ok) {
      showError('本地引擎启动失败', res.error ?? '');
    }
    void utils.account.intentSense.getLocalEngine.invalidate();
  }

  const downloading = local?.downloading || (progress !== null && !progress.done);

  return (
    <div
      className="modal-scrim group-keyword-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="weq-cvs-dialog weq-int-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="意图感知设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          className="weq-cvs-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="weq-cvs-body" style={{ gridTemplateColumns: 'none' }}>
          <div className="weq-cvs-body-head">
            <strong>意图感知</strong>
            <span>本地分析消息意图与情绪，推断对方互动画像（仅供娱乐）</span>
          </div>
          <div className="weq-cvs-body-scroll">
            <SectionHeader
              title="意图感知"
              icon={<BrainCircuit size={16} strokeWidth={1.8} />}
              desc="开启后，私聊最新对方消息与悬停的任意消息会显示意图/情绪胶囊；右上角出现好感度胶囊。"
            />
            <Card title="基础">
              <Row
                label="启用意图感知"
                desc="分析在本机完成（本地模型）或发送给你配置的 API（云端引擎）。"
                control={
                  <Toggle
                    checked={!!s?.enabled}
                    disabled={status.isLoading || setConfig.isLoading}
                    onChange={(next) => void patch({ enabled: next })}
                    label="启用意图感知"
                  />
                }
              />
              <Row
                label="回复建议"
                desc={
                  s?.engine === 'api'
                    ? '在输入框上方生成 3 条候选回复（需 API 引擎）。'
                    : '仅 API 引擎支持（本地 Laya 模型不生成文本）。'
                }
                control={
                  <Toggle
                    checked={!!s?.suggestionsEnabled}
                    disabled={
                      status.isLoading || s?.engine !== 'api' || !s?.apiConfigured || !s?.enabled
                    }
                    onChange={(next) => void patch({ suggestionsEnabled: next })}
                    label="回复建议"
                  />
                }
              />
            </Card>

            <Card title="引擎">
              <Row
                label="API（OpenAI 兼容）"
                desc="复用「克隆工厂」里配置的 provider；一次调用分析一批消息。"
                control={
                  <Toggle
                    checked={s?.engine === 'api'}
                    disabled={status.isLoading}
                    onChange={() => void patch({ engine: 'api' })}
                    label="使用 API 引擎"
                  />
                }
              />
              {s?.engine === 'api' ? (
                <Row
                  label="Provider / 模型"
                  desc={
                    providers.length === 0
                      ? '尚未配置任何 provider —— 先到「克隆工厂 → 模型服务」添加。'
                      : s.apiConfigured
                        ? undefined
                        : '当前选择不可用。'
                  }
                  control={
                    <select
                      className="weq-int-select"
                      value={
                        s.providerRef ? `${s.providerRef.providerId}::${s.providerRef.model}` : ''
                      }
                      disabled={providers.length === 0}
                      onChange={(e) => {
                        const [providerId, model] = e.target.value.split('::');
                        if (!providerId || !model) {
                          void patch({ providerRef: null });
                        } else {
                          void patch({ providerRef: { providerId, model } });
                        }
                      }}
                    >
                      <option value="">未选择</option>
                      {providers.map((p) =>
                        p.models.map((m) => (
                          <option key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`}>
                            {p.name} · {m.label ?? m.id}
                          </option>
                        )),
                      )}
                    </select>
                  }
                />
              ) : null}
              <Row
                label="本地模型（Laya 多语言 ONNX）"
                desc={
                  local?.available === false
                    ? '仅桌面版可用。'
                    : local?.engineReady
                      ? '引擎运行中。'
                      : local?.modelDownloaded
                        ? '模型已就绪，点击启动引擎。'
                        : '约 600MB，下载到用户数据目录，之后完全离线。'
                }
                control={
                  <Toggle
                    checked={s?.engine === 'local'}
                    disabled={status.isLoading || !local?.available || !local?.modelDownloaded}
                    onChange={() => void patch({ engine: 'local' })}
                    label="使用本地引擎"
                  />
                }
                indent
              />
              {local?.available && !local.modelDownloaded ? (
                <div className="weq-int-download">
                  <button
                    type="button"
                    className="weq-int-download-btn"
                    disabled={downloading}
                    onClick={() => void onDownload()}
                  >
                    {downloading ? (
                      <Download size={14} className="weq-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    <span>{downloading ? '下载中…' : '下载模型'}</span>
                  </button>
                  <label className="weq-int-mirror">
                    <input
                      type="checkbox"
                      checked={s?.hfMirror !== false}
                      onChange={(e) => void patch({ hfMirror: e.target.checked })}
                    />
                    使用 hf-mirror.com 镜像（国内网络建议开启）
                  </label>
                  {progress && !progress.done ? (
                    <div className="weq-int-progress" title={progress.currentFile ?? ''}>
                      <span
                        className="weq-int-progress-bar"
                        style={{
                          width:
                            progress.total > 0
                              ? `${Math.min(100, (progress.received / progress.total) * 100)}%`
                              : '0%',
                        }}
                      />
                      <em>
                        {fmtMB(progress.received)}
                        {progress.total > 0 ? ` / ${fmtMB(progress.total)}` : ''} ·{' '}
                        {progress.filesDone}/{progress.filesTotal} 个文件
                      </em>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {local?.available && local.modelDownloaded && !local.engineReady ? (
                <div className="weq-int-download">
                  <button
                    type="button"
                    className="weq-int-download-btn"
                    disabled={startEngine.isLoading}
                    onClick={() => void onStart()}
                  >
                    <Play size={14} />
                    <span>启动本地引擎</span>
                  </button>
                </div>
              ) : null}
            </Card>

            <p className="weq-set-note">
              意图与画像均为模型推断， 好感度/MBTI 仅供娱乐参考；API
              引擎会把消息文本发送给你配置的服务商。
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
