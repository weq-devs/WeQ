import type { ReactElement, ReactNode } from 'react';
import type { ReportPageManifest } from '@weq/service';

/** Props every report page component receives. `data` is narrowed per page. */
export type ReportPageProps<D = unknown> = {
  page: ReportPageManifest;
  data: D;
  /**
   * 该页是否为 deck 当前页。页面据此启动进场动画（数字滚动、逐层浮现），
   * 翻走后置 false 会重置，翻回来重播 —— 报告是「看」的，不是仪表盘。
   */
  active: boolean;
};

export type ReportPageComponent<D = unknown> = (props: ReportPageProps<D>) => ReactElement;

/**
 * 报告页画布。刻意不提供「小标题 + 大标题 + 描述」这套面板头部 —— 每一页
 * 自己决定排印，框架只负责三件共享的事：
 *
 *   - `ghost`：巨型描边衬底字（年份 / 关键数字），出血裁切，是全报告的视觉签名；
 *   - `eyebrow`：左上角一行细体标签 + 延伸的发丝线；
 *   - `active` 驱动的入场：`data-enter` 交给 CSS，子元素按 `--i` 错峰浮现。
 */
export function PageFrame({
  page,
  active,
  eyebrow,
  ghost,
  ghostPlacement = 'bottom-right',
  tone,
  children,
}: {
  page: ReportPageManifest;
  active: boolean;
  eyebrow?: ReactNode;
  /** 巨型描边衬底字，通常是年份。 */
  ghost?: ReactNode;
  ghostPlacement?: 'bottom-right' | 'top-left' | 'center';
  /** 页面色调，映射到 --weq-report-tone。 */
  tone?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <section
      className="weq-report-page"
      data-enter={active ? 'in' : 'out'}
      style={tone ? ({ '--weq-report-tone': tone } as React.CSSProperties) : undefined}
      aria-labelledby={`report-page-${page.id}`}
    >
      {ghost != null ? (
        <div className={`weq-report-ghost is-${ghostPlacement}`} aria-hidden>
          {ghost}
        </div>
      ) : null}
      {eyebrow != null ? (
        <div className="weq-report-eyebrow" style={{ '--i': 0 } as React.CSSProperties}>
          <span className="weq-report-eyebrow-text">{eyebrow}</span>
          <span className="weq-report-eyebrow-rule" aria-hidden />
        </div>
      ) : null}
      <div className="weq-report-canvas">{children}</div>
      <h1 id={`report-page-${page.id}`} className="weq-sr-only">
        {page.title}
      </h1>
    </section>
  );
}
