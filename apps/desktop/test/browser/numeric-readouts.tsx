import { createRoot } from 'react-dom/client';
import { ReminderCount } from '../../src/renderer/src/components/ReminderBadge';
import { DurationLabel, TimeLabel } from '../../src/renderer/src/components/TimeLabel';
import { NumericText } from '../../src/renderer/src/components/NumericText';
import { LongTaskRow } from '../../src/renderer/src/components/tasks/LongTaskRow';
import { DetailTree } from '../../src/renderer/src/components/performance/PerformanceCharts';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/api-usage.css';
import '../../src/renderer/src/styles/cache.css';
import '../../src/renderer/src/styles/call-recorder.css';
import '../../src/renderer/src/styles/conversation-overview-calendar.css';
import '../../src/renderer/src/styles/export.css';
import '../../src/renderer/src/styles/long-tasks.css';
import '../../src/renderer/src/styles/mail.css';
import '../../src/renderer/src/styles/message-calendar.css';
import '../../src/renderer/src/styles/qzone.css';
import '../../src/renderer/src/styles/unified-media-preview.css';
import '../../src/renderer/src/styles/annual-report.css';
import '../../src/renderer/src/styles/performance-monitor.css';
import '../../src/renderer/src/components/relationGraph/relationGraph.css';

function Fixture() {
  return (
    <main className="numeric-fixture">
      <style>{`
        body { margin: 0; background: var(--weq-bg-surface); color: var(--weq-fg-primary); }
        .numeric-fixture { max-width: 760px; margin: auto; padding: 16px; }
        .numeric-fixture > section { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--weq-border-subtle); }
        .numeric-fixture section > div { min-width: 0; }
        .numeric-fixture [data-readout] { overflow-wrap: anywhere; }
        .numeric-fixture table { width: 100%; }
        .numeric-fixture .weq-report-root { --rp-serif-base: Georgia, serif; --rp-mono: Georgia, serif; font-family: Georgia, serif; }
        .numeric-fixture .weq-density-calendar-grid { grid-column: 1 / -1; }
        .numeric-fixture :is([data-real-task], [data-real-performance], [data-real-seq]) { grid-column: 1 / -1; }
        .numeric-fixture [data-real-svg] text { fill: currentColor; }
      `}</style>
      <h1>数字排版</h1>
      <p data-body>普通正文 12345，保留原有字体。</p>
      <section>
        <div data-label>原有数字样式</div>
        <span className="weq-number" data-reference>
          12,345.67
        </span>
        <div data-label>数字输入框</div>
        <input className="weq-set-input" type="number" defaultValue="12345" data-readout />
      </section>
      <section>
        <div data-label>私聊统计</div>
        <div className="ba-stat">
          <strong data-readout data-weight="700">
            123,456
          </strong>
          <small>消息</small>
        </div>
        <div data-label>群聊统计</div>
        <div className="ga-ov-stat">
          <strong data-readout data-weight="700">
            1,234
          </strong>
          <small>活跃天数</small>
        </div>
        <div data-label>转账金额</div>
        <div className="weq-transfer-amount" data-readout data-weight="600">
          ¥12,345.67
        </div>
        <div data-label>红包金额</div>
        <div className="weq-redbag-qr-amount" data-readout data-weight="700">
          ¥123.45
        </div>
      </section>
      <section>
        <div data-label>文件大小</div>
        <div className="qq-media-file-size">
          <span className="weq-number" data-readout>
            128.5 MB
          </span>
        </div>
        <div data-label>清理项目</div>
        <span className="weq-clean-target-size" data-readout data-weight="700">
          12.34 GB
        </span>
        <div data-label>多选消息</div>
        <span className="selection-bar-count" data-readout data-weight="700">
          123
        </span>
        <div data-label>未读角标</div>
        <div>
          <ReminderCount count={128} data-readout data-weight="600" />
          <ReminderCount count={8} as="button" data-readout data-weight="600" />
        </div>
      </section>
      <section>
        <div data-label>消息时间</div>
        <div data-time>
          <TimeLabel value="2026-11-16 12:34:56" />
        </div>
        <div data-label>回复耗时</div>
        <strong data-duration>
          <DurationLabel seconds={125} />
        </strong>
        <div data-label>录音计时</div>
        <button type="button" className="voice-record-btn">
          <strong className="voice-record-timer" data-readout data-weight="600">
            12:34
          </strong>
        </button>
        <div data-label>通话录制</div>
        <span className="weq-call-recording-time" data-readout>
          01:23:45
        </span>
        <div data-label>任务进度</div>
        <div className="weq-task-progress-metric">
          <strong data-readout>42%</strong>
        </div>
        <div data-label>修复进度</div>
        <span className="weq-rp-progress-pct" data-readout>
          78%
        </span>
      </section>
      <section>
        <div data-label>API 请求</div>
        <div className="weq-api-usage">
          <dl className="weq-usage-summary">
            <div>
              <dt>次数</dt>
              <dd data-readout>12,345</dd>
            </div>
          </dl>
        </div>
        <div data-label>Token 用量</div>
        <div className="weq-usage-accounting-table">
          <table>
            <tbody>
              <tr>
                <th data-label>模型名称</th>
                <td data-readout>123,456</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div data-label>日历读数</div>
        <div className="weq-density-calendar-grid">
          <button type="button">
            <span data-readout>16</span>
            <small data-readout>1.2万</small>
          </button>
        </div>
        <div data-label>排行指标</div>
        <span className="weq-rank-value" data-readout data-weight="600">
          12,345
        </span>
        <div data-label>空间访问</div>
        <div className="weq-qzn-space-stats">
          <dl>
            <div>
              <dt>访问</dt>
              <dd data-readout>12,345</dd>
            </div>
          </dl>
        </div>
        <div data-label>邮件分页</div>
        <div className="weq-mail-pagination">
          <span data-readout>12 / 345</span>
        </div>
        <div data-label>预览计数</div>
        <span className="weq-preview-count" data-readout>
          12 / 34
        </span>
      </section>
      <section>
        <div data-label>任务列表</div>
        <div data-real-task>
          <LongTaskRow
            task={{
              id: 'numeric',
              name: '报告 2026.zip',
              kind: '闪传下载',
              status: 'running',
              progress: 42,
              note: '2 个文件 · 128.5 MB / 256 MB',
              icon: null,
              detail: null,
            }}
            active={false}
            onSelect={() => {}}
          />
        </div>
        <div data-label>性能详情</div>
        <div data-real-performance>
          <DetailTree
            value={{
              cpuPercent: 12.3,
              residentBytes: 134217728,
              count: 12345,
              name: 'worker 2026',
              enabled: true,
            }}
          />
        </div>
        <div data-label>超长序号</div>
        <strong className="weq-message-seq" data-real-seq>
          <NumericText>seq 90071992547409931234–90071992547409931235</NumericText>
        </strong>
        <div data-label>图表文字</div>
        <svg width="120" height="24" data-real-svg>
          <text y="16">
            <NumericText as="tspan">交集 12 / 34</NumericText>
          </text>
        </svg>
      </section>
      <section>
        <div data-label>混排按钮</div>
        <button type="button">
          <span data-label>点赞 </span>
          <span className="weq-number" data-readout>
            123
          </span>
        </button>
        <div data-label>技术内容</div>
        <code data-code>0x1234abcd</code>
        <div data-label>年度报告</div>
        <div className="weq-report-root" data-report-font="serif">
          <span className="weq-number" data-report-number>
            2026
          </span>
          <TimeLabel value="2026-11-16" precision="day" />
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
