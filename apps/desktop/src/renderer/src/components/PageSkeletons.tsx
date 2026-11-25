/**
 * 页面级加载骨架：只画真实布局的结构，不画内容。
 *
 * 用在「页面本身的表头、行高或消息气泡位置固定」的整块区域，数据到达时
 * 不发生明显跳动。轻量、结构不确定的页面仍用 PanelLoading 的转圈。
 */

import type { CSSProperties, ReactElement } from 'react';
import '../styles/page-skeletons.css';

function Bar({
  width = '100%',
  height = 9,
  radius = 5,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  className?: string;
}): ReactElement {
  const style: CSSProperties = { width, height, borderRadius: radius };
  return <span className={className ? `weq-skel ${className}` : 'weq-skel'} style={style} />;
}

/** 数据库浏览：左侧对象树 + 右侧工具条和表格行。 */
export function DatabaseBrowserSkeleton(): ReactElement {
  return (
    <div className="weq-skel-db" aria-hidden>
      <div className="weq-skel-db-tree">
        <Bar width={42} height={8} />
        <Bar width="86%" height={24} radius={6} />
        <Bar width="72%" height={8} />
        <Bar width="64%" height={8} />
        <Bar width="80%" height={8} />
        <Bar width={42} height={8} />
        <Bar width="78%" height={8} />
      </div>
      <div className="weq-skel-db-main">
        <div className="weq-skel-db-toolbar">
          <Bar width={210} height={26} radius={7} />
          <Bar width={64} height={26} radius={7} />
        </div>
        <div className="weq-skel-db-head">
          {[70, 150, 110, 90].map((width) => (
            <Bar key={width} width={width} height={9} />
          ))}
        </div>
        {Array.from({ length: 8 }, (_, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <div className="weq-skel-db-row" key={row}>
            <Bar width={46} />
            <Bar width={`${74 + ((row * 13) % 20)}%`} />
            <Bar width={`${48 + ((row * 7) % 18)}%`} />
            <Bar width={62} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 日志 / 性能监视：图表卡片 + 日志行。 */
export function MonitorPageSkeleton(): ReactElement {
  return (
    <div className="weq-skel-monitor" aria-hidden>
      <div className="weq-skel-monitor-card">
        <Bar width={120} height={10} />
        <div className="weq-skel-monitor-bars">
          {Array.from({ length: 24 }, (_, index) => (
            <Bar
              // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
              key={index}
              width="100%"
              height={`${38 + ((index * 17) % 46)}%`}
              radius={4}
              className="weq-skel-monitor-bar"
            />
          ))}
        </div>
      </div>
      <div className="weq-skel-monitor-card">
        {Array.from({ length: 5 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
          <Bar key={index} width={index % 2 ? '54%' : '86%'} height={8} />
        ))}
      </div>
    </div>
  );
}

/** 消息列表：头像 + 名称 + 气泡；左右交替。 */
export function MessageListSkeleton(): ReactElement {
  return (
    <div className="weq-skel-messages" aria-hidden>
      {Array.from({ length: 5 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态占位列表
        <div className={index % 2 ? 'weq-skel-message is-other' : 'weq-skel-message'} key={index}>
          <Bar width={30} height={30} radius={15} />
          <div className="weq-skel-message-copy">
            <Bar width={86} height={8} />
            <Bar width={index % 2 ? 210 : 330} height={index % 2 ? 32 : 44} radius={10} />
          </div>
        </div>
      ))}
    </div>
  );
}
