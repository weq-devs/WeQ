import { BrainCircuit, Download } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { ApiModelSelect } from './ApiModelSelect';
import { IntentTuningPanel } from './IntentTuningPanel';
import { useDialog } from '../Dialog';
import '../../styles/model-settings.css';

export function InteractionProfileSection() {
  const active = useTabActive();
  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const save = trpc.account.intentSense.setConfig.useMutation();
  const local = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const download = trpc.bootstrap.downloadLocalModel.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
  async function patch(input: Parameters<typeof save.mutateAsync>[0]) {
    try {
      const next = await save.mutateAsync(input);
      utils.account.intentSense.getStatus.setData(undefined, next);
      void utils.account.intentSense.getProfile.invalidate();
    } catch (error) {
      showError('互动画像设置失败', String(error));
    }
  }
  async function downloadModel() {
    try {
      const result = await download.mutateAsync({
        mirror: status.data?.hfMirror ?? true,
        modelId: status.data?.profileLocalModelId ?? 'auto',
      });
      if (!result.ok) throw new Error(result.error ?? '下载失败');
      await utils.bootstrap.getLocalEngine.invalidate();
      await utils.account.intentSense.getStatus.invalidate();
    } catch (error) {
      showError('画像模型下载失败', String(error));
    }
  }
  return (
    <div className="weq-set">
      <SectionHeader title="互动画像" icon={<BrainCircuit size={18} />} />
      <Card title="推断模型">
        <Row
          label="启用互动画像"
          control={
            <Toggle
              label="启用互动画像"
              checked={status.data?.profileEnabled ?? false}
              disabled={!status.data || save.isLoading}
              onChange={(profileEnabled) => void patch({ profileEnabled })}
            />
          }
        />
        <Row
          label="运行方式"
          control={
            <select
              className="weq-set-input"
              aria-label="互动画像运行方式"
              disabled={!status.data || save.isLoading}
              value={status.data?.profileEngine ?? 'heuristic'}
              onChange={(event) => {
                const mode = event.target.value;
                if (mode === 'api' || mode === 'local' || mode === 'heuristic')
                  void patch({ profileEngine: mode });
              }}
            >
              <option value="heuristic">仅本地统计</option>
              <option value="local">本地模型</option>
              <option value="api">独立 API 模型</option>
            </select>
          }
        />
        {status.data?.profileEngine === 'local' ? (
          <Row
            label="本地模型资源"
            control={
              <select
                className="weq-set-input"
                aria-label="互动画像本地模型资源"
                value={status.data.profileLocalModelId ?? 'auto'}
                disabled={save.isLoading || download.isLoading}
                onChange={(event) => {
                  const id = event.target.value;
                  if (id === 'auto' || id === 'laya-multilingual' || id === 'QWeQ-NineBird-v1')
                    void patch({ profileLocalModelId: id });
                }}
              >
                {(local.data?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.downloaded ? ' · 已就绪' : ' · 未就绪'}
                  </option>
                ))}
              </select>
            }
          />
        ) : null}
        {status.data?.profileEngine === 'local' &&
        local.data?.models.find((model) => model.id === status.data?.profileLocalModelId)
          ?.downloadable &&
        !local.data?.models.find((model) => model.id === status.data?.profileLocalModelId)
          ?.downloaded ? (
          <button
            type="button"
            className="weq-set-btn"
            disabled={download.isLoading || local.data?.downloading}
            onClick={() => void downloadModel()}
          >
            <Download size={14} />
            {download.isLoading ? '下载中…' : '下载画像模型'}
          </button>
        ) : null}
        {status.data?.profileEngine === 'api' ? (
          <Row
            label="API 模型"
            desc="将所选对方文本样本发送至该服务商用于画像推断。"
            control={
              <ApiModelSelect
                label="互动画像 API 模型"
                value={status.data.profileProviderRef}
                disabled={save.isLoading}
                onChange={(profileProviderRef) => void patch({ profileProviderRef })}
              />
            }
          />
        ) : null}
      </Card>
      <p className="weq-set-note">好感度、MBTI 和互动风格均为推断，仅供参考。</p>
      <details className="weq-model-advanced">
        <summary>高级设置</summary>
        <IntentTuningPanel group="profile" />
      </details>
    </div>
  );
}
