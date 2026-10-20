/**
 * 联系人页门面 —— 默认不直接铺力力图，先给一张「群交集」的落地页。
 *
 * 背景直接复用首页那套名片背景（{@link CardBackdrop} + `settings.homeDress`），所以
 * 换装扮时两处一起变；没有装扮时透出主题画布（`--chat-surface`），和聊天页一致。
 *
 * 下方是一组轻量统计（多少个群、多少位群友、多少对群有交集），点主按钮才进图谱。
 * 联系人不直接落在一张需要读完才能理解的力图上，而是先给人一个「要不要看」的选择。
 */

import { useMemo } from 'react';
import { ArrowRight, ScanLine, Sparkles, Users, Waypoints } from 'lucide-react';
import { CardBackdrop } from '../dressPieces';
import { dressUrl } from '../../lib/resourceUrl';
import { trpc } from '../../trpc/client';
import type { RelationGraphData } from './types';

export function RelationHome({
  data,
  loading,
  onEnter,
  onRefresh,
}: {
  data: RelationGraphData | undefined;
  loading: boolean;
  onEnter: () => void;
  onRefresh: () => void;
}) {
  const dress = trpc.account.getHomeDress.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const cardUrl = dressUrl(dress.data?.cardUrl ?? '');
  const cardVideoUrl = dressUrl(dress.data?.cardVideoUrl ?? '');
  const hasBackdrop = Boolean(cardUrl || cardVideoUrl);

  const stats = useMemo(() => {
    if (!data) return null;
    let pairs = 0;
    const seen = new Set<string>();
    for (const node of data.nodes) {
      for (let i = 0; i < node.groupCodes.length; i++) {
        for (let j = i + 1; j < node.groupCodes.length; j++) {
          const a = node.groupCodes[i] ?? '';
          const b = node.groupCodes[j] ?? '';
          const key = a < b ? `${a}|${b}` : `${b}|${a}`;
          if (seen.has(key)) continue;
          seen.add(key);
          pairs += 1;
        }
      }
    }
    return {
      groups: data.groups.length,
      people: data.nodes.length,
      pairs,
    };
  }, [data]);

  return (
    <section className={`weq-relhome${hasBackdrop ? ' is-onphoto' : ''}`}>
      <CardBackdrop imageUrl={cardUrl} videoUrl={cardVideoUrl} />

      <div className="weq-relhome-inner">
        <header className="weq-relhome-head">
          <span className="weq-relhome-badge">
            <Waypoints size={12} />
            群交集
          </span>
          <h1 className="weq-relhome-title">好友，群友分析</h1>
          <p className="weq-relhome-sub">只读群成员名单。分析哪些圈子其实是一拨人。</p>
        </header>

        <div className="weq-relhome-actions">
          <button className="weq-relhome-cta" type="button" onClick={onEnter} disabled={loading}>
            {loading ? <span className="weq-relhome-cta-spinner" /> : <Sparkles size={15} />}
            {loading ? '正在扫描群成员…' : data ? '查看群交集' : '计算群交集'}
            {loading ? null : <ArrowRight size={15} />}
          </button>
          <button
            className="weq-relhome-refresh"
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="重新扫描全部群成员"
          >
            <ScanLine size={14} />
            重新扫描
          </button>
        </div>

        {stats ? (
          <dl className="weq-relhome-stats">
            <div>
              <dt>
                <Users size={12} />
                有跨群成员的群
              </dt>
              <dd>{stats.groups.toLocaleString('zh-CN')}</dd>
            </div>
            <div>
              <dt>
                <Waypoints size={12} />
                跨群群友
              </dt>
              <dd>{stats.people.toLocaleString('zh-CN')}</dd>
            </div>
            <div>
              <dt>
                <ArrowRight size={12} />
                有交集的群对
              </dt>
              <dd>{stats.pairs.toLocaleString('zh-CN')}</dd>
            </div>
          </dl>
        ) : null}

        <p className="weq-relhome-hint">
          <ScanLine size={12} />
          成员名单来自本地群资料库，随时可重新扫描
        </p>
      </div>
    </section>
  );
}
