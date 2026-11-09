import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GraphCanvas } from '../../src/renderer/src/components/relationGraph/GraphCanvas';
import { buildGraph } from '../../src/renderer/src/components/relationGraph/graphModel';
import type {
  GraphSettings,
  RelationGraphData,
} from '../../src/renderer/src/components/relationGraph/types';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/components/relationGraph/relationGraph.css';

const settings: GraphSettings = {
  mode: 'people',
  nodeLimit: 100,
  minCommon: 2,
  friendsOnly: false,
  intimacySize: true,
  intimacyPull: false,
  groupLevelSize: false,
  groupLevelPull: false,
  groupFilterMode: 'all',
  groupFilter: [],
  overlapGroupLimit: 30,
  overlapThreshold: 3,
  overlapDirection: 'large',
  overlapSort: 'overlap',
  showAvatars: false,
  showValues: true,
};
const params = new URLSearchParams(location.search);
const count = Math.max(200, Math.min(1000, Number(params.get('count')) || 200));
const dense = params.has('dense');
const groupCount = dense ? count : 8;
const allGroups = Array.from({ length: groupCount }, (_, i) => `group-${i}`);
const data: RelationGraphData = {
  selfUin: '',
  scannedGroups: groupCount,
  builtAt: 0,
  nodes: Array.from({ length: count }, (_, i) => ({
    uid: `person-${i}`,
    uin: '',
    nick: `成员 ${i}`,
    card: '',
    groupCount: dense ? groupCount : 2,
    groupCodes: dense
      ? allGroups
      : [
          `group-${Math.floor(i / (count / 4)) * 2}`,
          `group-${Math.floor(i / (count / 4)) * 2 + 1}`,
        ],
    intimacy: dense || i % 4 === 0 ? 1800 : 100,
    isFriend: dense || i % 3 === 0,
  })),
  groups: Array.from({ length: groupCount }, (_, i) => ({
    code: `group-${i}`,
    name: `群聊 ${i}`,
    memberCount: dense ? count : 50,
    sharedCount: dense ? count : 50,
    myLevel: dense ? 180 : 20,
  })),
};

Object.assign(window, { relationLayoutQa: { theme: useThemeStore } });
function Fixture() {
  const [mode, setMode] = useState<'people' | 'groups'>(
    params.get('mode') === 'groups' ? 'groups' : 'people',
  );
  const [sparse, setSparse] = useState(false);
  const [mounted, setMounted] = useState(true);
  const [limit, setLimit] = useState(params.has('count') ? count : 100);
  const graph = useMemo(() => {
    const start = performance.now();
    const result = buildGraph(data, {
      ...settings,
      mode,
      nodeLimit: limit,
      minCommon: sparse ? 60 : 2,
      intimacyPull: params.has('strong'),
      groupLevelPull: params.has('strong'),
    });
    Object.assign(window.relationLayoutQa, {
      buildMs: performance.now() - start,
      edges: result.edges.length,
      graph: result,
    });
    for (const node of result.nodes) node.avatarUrl = null;
    return result;
  }, [mode, sparse, limit]);
  return (
    <section className="weq-graph-embed" style={{ height: '100dvh', gridTemplateRows: '1fr' }}>
      <div className="weq-graph-stage">
        <div className="weq-graph-overlay">
          <div className="weq-graph-overlay-bar">
            <button type="button" onClick={() => setMode(mode === 'people' ? 'groups' : 'people')}>
              切换模式
            </button>
            <button type="button" onClick={() => setSparse(!sparse)}>
              切换疏密
            </button>
            <button type="button" onClick={() => setLimit(limit === 100 ? 200 : 100)}>
              切换数量
            </button>
            {params.has('worker') ? (
              <button type="button" onClick={() => setMounted(!mounted)}>
                切换图谱
              </button>
            ) : null}
          </div>
          <span className="weq-graph-overlay-stat">
            {graph.nodes.length} 节点 · {graph.edges.length} 连线
          </span>
        </div>
        {mounted ? (
          <GraphCanvas
            graph={graph}
            selectedId={null}
            onSelect={(node) => {
              Object.assign(window.relationLayoutQa, { selected: node?.id ?? null });
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
