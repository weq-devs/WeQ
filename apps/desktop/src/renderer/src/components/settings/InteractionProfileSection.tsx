import { BrainCircuit, Download } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { TabActivity, useTabActive } from '../RetainedTabs';
import { Card, Row, SectionHeader, Toggle, QueryError } from './controls';
import { ApiModelSelect } from './ApiModelSelect';
import { IntentTuningPanel } from './IntentTuningPanel';
import { useDialog } from '../Dialog';
import '../../styles/model-settings.css';

export function InteractionProfileSection() {
  const active = useTabActive();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const status = trpc.account.intentSense.getStatus.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
  });
  const save = trpc.account.intentSense.setConfig.useMutation();
  const local = trpc.bootstrap.getLocalEngine.useQuery(undefined, {
    enabled: active && status.data?.profileEngine === 'local',
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
      {status.error ? (
        <QueryError
          message={status.error.message}
          retryLabel="重新读取画像设置"
          onRetry={() => void status.refetch()}
        />
      ) : null}
      <Card title="推断模型">
        <Row
          settingId="profile-enabled"
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
          settingId="profile-engine"
          label="运行方式"
          control={
            <SegmentedControl
              label="互动画像运行方式"
              disabled={!status.data || save.isLoading}
              value={status.data?.profileEngine ?? 'heuristic'}
              onChange={(profileEngine) => void patch({ profileEngine })}
              options={[
                { value: 'heuristic', label: '本地统计' },
                { value: 'local', label: '本地模型' },
                { value: 'api', label: 'API 模型' },
              ]}
            />
          }
        />
        {status.data?.profileEngine === 'local' ? (
          <Row
            settingId="profile-local-model"
            label="本地模型资源"
            desc={`模型资源全局共享，当前账号单独选择画像使用的模型。${local.data?.available === false ? ' 当前宿主不支持本地画像模型。' : ''}`}
            control={
              <select
                className="weq-set-input"
                aria-label="互动画像本地模型资源"
                value={status.data.profileLocalModelId ?? 'auto'}
                disabled={
                  save.isLoading ||
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
        ) : (
          <p className="weq-set-note" data-setting-id="profile-local-model">
            本地模型资源：
            {!status.data
              ? '运行方式待确认'
              : status.data.profileEngine === 'api'
                ? '当前使用 API 模型'
                : '当前使用本地统计'}
            。
          </p>
        )}
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
            settingId="profile-api-model"
            label="API 模型"
            desc="将所选对方文本样本发送至该服务商用于画像推断。"
            control={
              <ApiModelSelect
                allowDefault
                label="互动画像 API 模型"
                value={status.data.profileProviderRef}
                disabled={save.isLoading}
                onChange={(profileProviderRef) => void patch({ profileProviderRef })}
              />
            }
          />
        ) : (
          <p className="weq-set-note" data-setting-id="profile-api-model">
            API 模型：
            {!status.data
              ? '运行方式待确认'
              : status.data.profileEngine === 'local'
                ? '当前使用本地模型'
                : '当前使用本地统计'}
            。
          </p>
        )}
      </Card>
      <p className="weq-set-note">好感度、MBTI 和互动风格均为推断，仅供参考。</p>
      <details
        className="weq-model-advanced"
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary data-setting-id="profile-advanced">高级设置</summary>
        <TabActivity active={active && advancedOpen}>
          <IntentTuningPanel group="profile" />
        </TabActivity>
      </details>
    </div>
  );
}
import { SegmentedControl } from '../SegmentedControl';
