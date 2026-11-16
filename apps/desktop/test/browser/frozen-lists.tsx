import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OverlapMatrix } from '../../src/renderer/src/components/relationGraph/OverlapMatrix';
import type { OverlapModel } from '../../src/renderer/src/components/relationGraph/graphModel';
import { HexDump } from '../../src/renderer/src/components/HexDump';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/components/relationGraph/relationGraph.css';
import '../../src/renderer/src/styles/cache.css';
import '../../src/renderer/src/styles/api-usage.css';
import '../../src/renderer/src/styles/group-file-manager.css';

const count = 100;
const groups = Array.from({ length: count }, (_, index) => ({
  code: String(index + 1),
  name: `合成群 ${index + 1}`,
  memberCount: 100,
  poolSize: 100,
  overlapSum: 100,
  avatarUrl: null,
}));
const model: OverlapModel = {
  groups,
  pairs: groups.flatMap((group, index) =>
    groups.slice(index + 1).map((other) => ({
      a: group.code,
      b: other.code,
      weight: 10,
      ratio: 0.1,
    })),
  ),
  maxWeight: 10,
  totalPeople: 100,
};
const rows = Array.from({ length: 60 }, (_, index) => index + 1);

function Fixture() {
  const [avatars, setAvatars] = useState(true);
  const [opened, setOpened] = useState('');
  return (
    <main style={{ padding: 16, maxWidth: 720, margin: 'auto', color: 'var(--weq-fg-primary)' }}>
      <button type="button" onClick={() => setAvatars(!avatars)}>
        切换矩阵标签
      </button>
      <output>{opened}</output>
      <section data-fixture="matrix" style={{ position: 'relative', height: 360 }}>
        <OverlapMatrix
          model={avatars ? { ...model, groups: groups.slice(0, 60) } : model}
          showAvatars={avatars}
          showValues
          direction="large"
          threshold={1}
          onOpenPair={({ a, b }) => setOpened(`${a}:${b}`)}
        />
      </section>
      <section data-fixture="database" style={{ display: 'flex', height: 260, minWidth: 0 }}>
        <div className="weq-cache-grid-scroll">
          <table className="weq-cache-grid">
            <thead>
              <tr>
                <th className="weq-cache-grid-rownum">#</th>
                {rows.slice(0, 10).map((n) => (
                  <th key={n}>column_{n}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n}>
                  <td className="weq-cache-grid-rownum">{n}</td>
                  {rows.slice(0, 10).map((c) => (
                    <td key={c}>
                      cell_{n}_{c}_long_value
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section data-fixture="files" className="weq-group-file-manager" style={{ marginTop: 16 }}>
        <div className="weq-file-manager-toolbar">
          <input aria-label="搜索群文件" />
        </div>
        <div className="weq-file-manager-table-scroll">
          <table className="weq-file-manager-table">
            <thead>
              <tr>
                {['选择', '名称', '大小', '上传者', '修改时间', '操作'].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n}>
                  <td>
                    <input type="checkbox" aria-label={`选择文件 ${n}`} />
                  </td>
                  <td>合成文件 {n}.txt</td>
                  <td>10 KB</td>
                  <td>合成用户</td>
                  <td>2026-11-16</td>
                  <td>
                    <button type="button">保存</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section data-fixture="usage" style={{ height: 300, overflow: 'auto', marginTop: 16 }}>
        <div style={{ height: 80 }}>API 用量</div>
        <div
          className="weq-usage-accounting-table"
          tabIndex={0}
          role="region"
          aria-label="合成用量"
        >
          <table>
            <thead>
              <tr>
                {['服务商 / 模型', '请求', '已知 token', '用量未知'].map((label) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((n) => (
                <tr key={n}>
                  <th>合成模型 {n}</th>
                  <td>{n}</td>
                  <td>{n * 100}</td>
                  <td>0</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ height: 100 }} />
      </section>
      <section
        data-fixture="notifications"
        className="weq-set-card"
        style={{ display: 'block', height: 300, overflow: 'auto', marginTop: 16 }}
      >
        <div style={{ height: 80 }}>事件通知</div>
        <table className="weq-notification-table" style={{ width: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>事件类型</th>
              <th>应用内横幅通知</th>
              <th>系统通知</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 26).map((n) => (
              <tr key={n}>
                <th>合成事件 {n}</th>
                {['横幅', '系统'].map((label) => (
                  <td key={label}>
                    <button type="button" aria-label={`${label} ${n}`}>
                      开关
                    </button>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ height: 100 }} />
      </section>
      <section
        data-fixture="hex"
        className="weq-cap"
        style={{ display: 'flex', width: 'min(100%, 340px)', height: 260, marginTop: 16 }}
      >
        <HexDump
          bytes={Uint8Array.from({ length: 4096 }, (_, index) => index % 256)}
          copyText="00"
        />
      </section>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
