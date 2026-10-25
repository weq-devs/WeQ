import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RendererErrorBoundary } from '../../src/renderer/src/components/RendererErrorBoundary';
import { ShimmerImage } from '../../src/renderer/src/components/ShimmerImage';
import { TabActivity } from '../../src/renderer/src/components/RetainedTabs';
import '../../src/renderer/src/styles/index.css';

const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 480;
const context = canvas.getContext('2d')!;
context.fillStyle = '#218c61';
context.fillRect(0, 0, 640, 480);
context.fillStyle = '#e8bf48';
context.fillRect(64, 64, 240, 240);
const src = canvas.toDataURL();

function Fixture() {
  const [active, setActive] = useState(true);
  const [failed, setFailed] = useState(false);
  if (failed) throw new Error('synthetic-render-failure');
  return (
    <>
      <button type="button" onClick={() => setActive((value) => !value)}>
        切换标签
      </button>
      <button type="button" onClick={() => setFailed(true)}>
        触发异常
      </button>
      <TabActivity active={active}>
        <div data-media style={{ position: 'relative', width: 200, height: 150 }}>
          <ShimmerImage suspendOffscreen src={src} style={{ maxWidth: 200, maxHeight: 150 }} />
        </div>
      </TabActivity>
      <div style={{ height: 2200 }} />
    </>
  );
}

createRoot(document.getElementById('root')!, { onCaughtError: () => {} }).render(
  <RendererErrorBoundary>
    <Fixture />
  </RendererErrorBoundary>,
);
