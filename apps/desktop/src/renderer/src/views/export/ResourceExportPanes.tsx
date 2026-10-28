import { useState } from 'react';
import { RotateCw, Search } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../../components/RetainedTabs';
import { ExportTab } from '../agentlab/PersonaSettingsModal';
import { SingleSelectPicker } from './SingleSelectPicker';
import { Segmented } from './widgets';
import type { QzoneExportContent } from './types';
import '../../styles/resource-export-panes.css';

export function PersonaBotExportPane() {
  const active = useTabActive();
  const personas = trpc.account.listAgentLabPersonas.useQuery(undefined, { enabled: active });
  const [id, setId] = useState<string | null>(null);
  const selected = personas.data?.find((item) => item.id === id);
  return (
    <section className="weq-resource-export-pane" aria-label="克隆体机器人导出">
      {personas.isError ? (
        <p role="alert">
          克隆体加载失败{' '}
          <button
            type="button"
            title="重试加载克隆体"
            aria-label="重试加载克隆体"
            onClick={() => void personas.refetch()}
          >
            <RotateCw size={15} />
          </button>
        </p>
      ) : null}
      <SingleSelectPicker
        items={(personas.data ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          avatarUrl: null,
        }))}
        loading={personas.isLoading}
        selectedId={id}
        onSelect={setId}
        searchPlaceholder="搜索克隆体"
        emptyText="暂无克隆体"
      />
      {selected ? <ExportTab key={selected.id} persona={selected} /> : null}
    </section>
  );
}

export function QzoneTargetInput({
  onAdd,
  disabled = false,
}: {
  onAdd: (uin: string) => void;
  disabled?: boolean;
}) {
  const [target, setTarget] = useState('');
  const valid = /^[1-9]\d*$/.test(target.trim());
  return (
    <section className="weq-resource-export-pane" aria-label="添加空间导出目标">
      <form
        className="weq-resource-export-target"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && !disabled) {
            onAdd(target.trim());
            setTarget('');
          }
        }}
      >
        <label>
          空间 QQ 号
          <input
            aria-label="空间 QQ 号"
            inputMode="numeric"
            disabled={disabled}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </label>
        <button type="submit" className="weq-exp-secondary" disabled={!valid || disabled}>
          <Search size={15} /> 添加空间
        </button>
      </form>
    </section>
  );
}

export function QzoneContentSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: QzoneExportContent;
  onChange: (value: QzoneExportContent) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="weq-qzone-export-content" disabled={disabled} aria-label="空间导出内容">
      <Segmented
        value={value}
        onChange={onChange}
        options={[
          { value: 'posts', label: '空间' },
          { value: 'both', label: '都导出' },
          { value: 'albums', label: '相册' },
        ]}
      />
    </fieldset>
  );
}
