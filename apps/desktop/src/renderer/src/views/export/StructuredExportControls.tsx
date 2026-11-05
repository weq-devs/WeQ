import { SegmentedControl } from '../../components/SegmentedControl';
import { useState } from 'react';
import { useDialog } from '../../components/Dialog';
import {
  EXPORT_EXTRA_LABELS,
  type ExportExtraKey,
  type ExportExtraOptions,
} from '@weq/service/export-content';
import '../../styles/structured-export.css';
import '../../styles/export-content-selector.css';

export interface StructuredExportOptions {
  extra?: ExportExtraOptions;
  profile?: 'basic' | 'full';
  incrementalSupport?: boolean;
}
export interface ResourceArchiveOptions extends StructuredExportOptions {
  metadataFormat?: 'json' | 'jsonl' | 'none';
}
// 保留各导出页面的组件入口；策略已统一，旧选项不再作为可编辑控件展示。
export function StructuredExportControls(props: {
  domain?: ExportExtraKey;
  onRequireJson?: () => void;
  options: StructuredExportOptions;
  formats: readonly string[];
  chatlab?: boolean;
  disabled?: boolean;
  onChange: (value: StructuredExportOptions) => void;
}) {
  return (
    <>
      <ExportFormatHint />
      {props.domain ? (
        <BusinessExportDetails
          domain={props.domain}
          options={props.options}
          disabled={props.disabled}
          onChange={props.onChange}
          formats={props.formats}
          onRequireJson={props.onRequireJson}
        />
      ) : null}
    </>
  );
}
export function BusinessExportDetails({
  domain,
  options,
  disabled,
  onChange,
  formats,
  onRequireJson,
}: {
  domain: ExportExtraKey;
  options: StructuredExportOptions;
  disabled?: boolean;
  onChange: (value: StructuredExportOptions) => void;
  formats?: readonly string[];
  onRequireJson?: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const confirm = useDialog((state) => state.confirm);
  const native =
    formats === undefined || formats.some((format) => format === 'json' || format === 'jsonl');
  return (
    <div className="weq-export-content-row">
      <span className="weq-export-content-label">{EXPORT_EXTRA_LABELS[domain]}</span>
      <SegmentedControl
        label={EXPORT_EXTRA_LABELS[domain]}
        value={(options.extra?.[domain] ?? native) ? 'local' : 'none'}
        disabled={disabled || asking}
        onChange={(value) => {
          void (async () => {
            let selected = value === 'local';
            if (selected && !native) {
              setAsking(true);
              try {
                selected = await confirm(
                  '所选数据需要 JSON/JSONL',
                  '是否同时选中 JSON 格式？不添加时不启用这项附加数据。',
                  { okLabel: '选中 JSON', cancelLabel: '不添加 JSON', tone: 'info' },
                );
                if (selected) onRequireJson?.();
              } finally {
                setAsking(false);
              }
            }
            onChange({ extra: { ...options.extra, [domain]: selected } });
          })();
        }}
        options={[
          { value: 'none', label: '不导出' },
          { value: 'local', label: '仅本地' },
          { value: 'cloud', label: '云端补全', hidden: true },
        ]}
      />
    </div>
  );
}
export function ResourceArchiveControls({
  options,
  onChange,
  disabled,
}: {
  options: ResourceArchiveOptions;
  onChange: (value: ResourceArchiveOptions) => void;
  disabled?: boolean;
}) {
  const format = options.metadataFormat ?? 'json';
  return (
    <div className="weq-resource-archive-controls">
      <div className="weq-export-format-heading">
        <span>导出格式</span>
        <ExportFormatHint />
      </div>
      <SegmentedControl
        label="清单格式"
        value={format}
        disabled={disabled}
        onChange={(metadataFormat) =>
          onChange({
            metadataFormat,
            incrementalSupport: metadataFormat !== 'none',
            ...(metadataFormat === 'none'
              ? { extra: { ...options.extra, resourceProperties: false } }
              : {}),
          })
        }
        options={[
          { value: 'json', label: 'JSON' },
          { value: 'jsonl', label: 'JSONL' },
          { value: 'none', label: '仅资源' },
        ]}
      />
      <BusinessExportDetails
        domain="resourceProperties"
        options={options}
        disabled={disabled}
        onChange={onChange}
        formats={format === 'none' ? [] : [format]}
        onRequireJson={() => onChange({ metadataFormat: 'json', incrementalSupport: true })}
      />
    </div>
  );
}
export function structuredExportOptions(
  _options: StructuredExportOptions,
  formats: readonly string[],
  chatlab = false,
): StructuredExportOptions & { profile: 'full'; incrementalSupport: boolean } {
  return {
    ...(_options.extra ? { extra: _options.extra } : {}),
    profile: 'full',
    incrementalSupport:
      !chatlab && formats.some((format) => format === 'json' || format === 'jsonl'),
  };
}
export function ExportFormatHint() {
  return <small className="weq-exp-format-note">仅 json/jsonl 支持增量导出</small>;
}
