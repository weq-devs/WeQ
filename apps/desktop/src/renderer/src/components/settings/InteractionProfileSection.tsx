import { Download } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { SegmentedControl } from '../SegmentedControl';
import { Row, Toggle, QueryError } from './controls';
import { ApiModelRow } from './ApiModelSelect';
import { IntentTuningPanel } from './IntentTuningPanel';
import { useDialog } from '../Dialog';
import { AiFeatureSettingsLayout } from './AiFeatureSettingsLayout';
import { useAiFeatureSettings } from './useAiFeatureSettings';

export function InteractionProfileSection() {
  const settings = useAiFeatureSettings('互动画像');
  const { active, status, disabled, patch } = settings;
  const local = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    enabled: active && status.data?.profileEngine === 'local',
    refetchOnWindowFocus: false,
  });
  const download = trpc.bootstrap.downloadLocalModel.useMutation();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);
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
    <AiFeatureSettingsLayout
      settings={settings}
      title="互动画像"
      error={status.error}
      retrying={status.isFetching}
      onRetry={() => void status.refetch()}
      basic={
        <>
          <Row
            settingId="profile-enabled"
            label="启用互动画像"
            desc="统计互动情况，分析好感度、MBTI 倾向与互动风格。"
            control={
              <Toggle
                label="启用互动画像"
                checked={status.data?.profileEnabled ?? false}
                indeterminate={!status.data}
                disabled={disabled}
                onChange={(profileEnabled) => void patch({ profileEnabled })}
              />
            }
          />
          <Row
            settingId="profile-mode"
            label="模式"
            control={
              <SegmentedControl
                label="互动画像模式"
                value={status.data ? (status.data.profileMode ?? 'auto') : null}
                disabled={disabled}
                onChange={(profileMode) => void patch({ profileMode })}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'manual', label: '手动' },
                ]}
              />
            }
          />
        </>
      }
      model={
        <>
          <Row
            settingId="profile-engine"
            label="运行方式"
            control={
              <span
                data-setting-fallback={
                  status.data
                    ? status.data.profileEngine === 'api'
                      ? 'profile-local-model'
                      : status.data.profileEngine === 'local'
                        ? 'profile-api-model'
                        : 'profile-api-model profile-local-model'
                    : undefined
                }
              >
                <SegmentedControl
                  label="互动画像运行方式"
                  disabled={disabled}
                  value={status.data?.profileEngine ?? null}
                  onChange={(profileEngine) => void patch({ profileEngine })}
                  options={[
                    { value: 'api', label: 'API 模型' },
                    { value: 'local', label: '本地模型' },
                    { value: 'heuristic', label: '本地统计' },
                  ]}
                />
              </span>
            }
          />
          {status.data?.profileEngine === 'api' ? (
            <ApiModelRow
              settingId="profile-api-model"
              label="互动画像 API 模型"
              value={status.data.profileProviderRef}
              disabled={disabled}
              onChange={(profileProviderRef) => void patch({ profileProviderRef })}
            />
          ) : null}
          {status.data?.profileEngine === 'local' ? (
            <Row
              settingId="profile-local-model"
              label="本地模型资源"
              desc={`画像模型设置在各账号和各端共享。${local.data?.available === false ? ' 当前宿主不支持本地画像模型。' : ''}`}
              control={
                <select
                  className="weq-set-input"
                  aria-label="互动画像本地模型资源"
                  value={status.data.profileLocalModelId ?? 'auto'}
                  disabled={
                    disabled ||
                    download.isLoading ||
                    !local.data?.available ||
                    !local.data.models.length
                  }
                  onChange={(event) => {
                    const id = event.target.value;
                    if (id === 'auto' || id === 'laya-multilingual' || id === 'QWeQ-NineBird-v1')
                      void patch({ profileLocalModelId: id });
                  }}
                >
                  {!local.data?.models.some(
                    (model) => model.id === (status.data?.profileLocalModelId ?? 'auto'),
                  ) ? (
                    <option value={status.data.profileLocalModelId ?? 'auto'}>
                      {status.data.profileLocalModelId && status.data.profileLocalModelId !== 'auto'
                        ? status.data.profileLocalModelId
                        : '自动选择'}{' '}
                      · 当前不可用
                    </option>
                  ) : null}
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
              className="weq-set-btn weq-set-btn-soft"
              disabled={disabled || download.isLoading || local.data?.downloading}
              onClick={() => void downloadModel()}
            >
              <Download size={14} />
              {download.isLoading ? '下载中…' : '下载画像模型'}
            </button>
          ) : null}
          {status.data?.profileEngine === 'local' && local.error ? (
            <QueryError
              message={local.error.message}
              retryLabel="重新读取本地模型资源"
              retrying={local.isFetching}
              onRetry={() => void local.refetch()}
            />
          ) : null}
        </>
      }
    >
      {() => <IntentTuningPanel group="profile" />}
    </AiFeatureSettingsLayout>
  );
}
