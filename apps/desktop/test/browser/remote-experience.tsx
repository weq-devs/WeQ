import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AnnualReportStage } from '../../src/renderer/src/views/annual-report/AnnualReportStage';
import { CallWindow } from '../../src/renderer/src/components/CallWindow';
import {
  ClientDocumentPreview,
  presentClientDocument,
} from '../../src/renderer/src/components/ClientDocumentPreview';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/annual-report.css';

ensureThemeInitialized();
const paragraphs = Array.from({ length: 18 }, (_, index) => ({
  id: `row-${index}`,
  text: `阅读内容 ${index + 1}：先浏览这一页，再继续翻页。`,
}));
function Fixture() {
  const [mode, setMode] = useState('report');
  const [index, setIndex] = useState(1);
  Object.assign(window, {
    remoteExperience: {
      setMode,
      theme: useThemeStore,
      preview: () => presentClientDocument({ openUrl: '/_download/report-fixture' }, '合成报告'),
    },
  });
  if (mode === 'call')
    return (
      <CallWindow
        initial={{
          state: 'calling',
          roomId: 'fixture',
          peerUin: '10001',
          peerUid: 'u_fixture',
          peerName: '合成好友',
          peerAvatar: '',
          backgroundUrl: '',
          backgroundVideoUrl: '',
          startedAt: null,
          connectedAt: null,
          endReason: null,
          lastError: null,
          sentFrames: 0,
          receivedFrames: 0,
          durationSec: 0,
          videoSending: false,
          videoReceiving: false,
          receivedVideoFrames: 0,
          videoInfo: null,
          videoSource: 'camera',
          videoProfile: null,
        }}
        onClose={() => setMode('report')}
      />
    );
  return (
    <>
      <div className="weq-report-root is-deck" style={{ height: '100dvh' }}>
        <output data-report-index>{index}</output>
        <AnnualReportStage index={index} count={3} onIndexChange={setIndex}>
          {[0, 1, 2].map((page) => (
            <section key={page} className={`weq-report-slide${index === page ? ' is-active' : ''}`}>
              <div className="weq-report-page">
                <div className="weq-report-canvas">
                  <h2>这一年的聊天</h2>
                  <p>年度报告合成回归，第 {page + 1} 页</p>
                  <button type="button" className="weq-action-soft">
                    分享报告
                  </button>
                  {paragraphs.map((row) => (
                    <p key={row.id}>{row.text}</p>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </AnnualReportStage>
      </div>
      <ClientDocumentPreview />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
