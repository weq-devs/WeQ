/**
 * 本地缓存资源中心（单页）。
 *
 * 布局：左侧竖向分类列表 + 右侧当前分类内容区。用于查看并清理本地缓存，
 * 节省磁盘空间。分类包括本地数据库、nt_data 下的头像 / 各类表情 / 文件 /
 * 图片墙 / 图片 / 视频 / 语音，以及 QQ 空间缓存。
 *
 * 本轮仅「数据库」分类落地（查看 + 修改，走 account.dbExplorer.*）；其余分类
 * 为前端占位（居中空状态 + 「开发中」标签），等待后端与前端逐个补齐。
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import {
  Database,
  Image as ImageIcon,
  Images,
  Smile,
  Store,
  Sticker,
  Folder,
  FileDown,
  Film,
  AudioLines,
  Cloud,
  Construction,
  PanelLeftClose,
  PanelLeftOpen,
  ChartPie,
} from 'lucide-react';
import { DbExplorer } from './DbExplorer';
import { AvatarExplorer } from './AvatarExplorer';
import { SysEmojiExplorer } from './SysEmojiExplorer';
import { MarketEmojiExplorer } from './MarketEmojiExplorer';
import { CustomEmojiExplorer } from './CustomEmojiExplorer';
import { RelatedEmojiExplorer } from './RelatedEmojiExplorer';
import { FileDirExplorer } from './FileDirExplorer';
import { DownloadFileExplorer } from './DownloadFileExplorer';
import { FlatMediaExplorer, MonthMediaExplorer, VoiceExplorer } from './MediaResourceExplorers';
import { ResourceAnalyticsDialog } from './ResourceAnalyticsDialog';
import '../../styles/cache.css';

/** 一个缓存资源分类。`ready` 为 false 时右侧渲染占位空状态。 */
interface CacheCategory {
  id: string;
  label: string;
  desc: string;
  icon: ReactNode;
  ready: boolean;
}

const CATEGORIES: CacheCategory[] = [
  { id: 'database', label: '本地数据库', desc: '查看 / 修改 QQ 数据库', icon: <Database size={18} />, ready: true },
  { id: 'avatar', label: '头像资源', desc: 'nt_data 头像缓存', icon: <ImageIcon size={18} />, ready: true },
  { id: 'sysEmoji', label: '系统表情', desc: '内置表情资源', icon: <Smile size={18} />, ready: true },
  { id: 'marketEmoji', label: '商城表情', desc: '商城下载的贴纸', icon: <Store size={18} />, ready: true },
  { id: 'customEmoji', label: '自定义表情', desc: '收到的 / 我的表情', icon: <Sticker size={18} />, ready: true },
  { id: 'relatedEmoji', label: '关联表情', desc: '关键词联想表情', icon: <Smile size={18} />, ready: true },
  { id: 'fileDir', label: 'File 目录', desc: 'nt_data File 目录', icon: <Folder size={18} />, ready: true },
  { id: 'downloadFile', label: '下载文件', desc: '下载到本地的文件', icon: <FileDown size={18} />, ready: true },
  { id: 'album', label: '图片墙资源', desc: '群相册 / 图片墙缓存', icon: <Images size={18} />, ready: true },
  { id: 'image', label: '图片资源', desc: '聊天图片缓存', icon: <ImageIcon size={18} />, ready: true },
  { id: 'video', label: '视频资源', desc: '聊天视频缓存', icon: <Film size={18} />, ready: true },
  { id: 'voice', label: '语音资源', desc: '聊天语音缓存', icon: <AudioLines size={18} />, ready: true },
  { id: 'qzone', label: 'QQ空间缓存', desc: '空间浏览缓存', icon: <Cloud size={18} />, ready: true },
];

export function CacheView(): ReactElement {
  const [active, setActive] = useState<string>('database');
  // 资源选择列可收起，收起后腾出空间给右侧数据表接近全屏查看。
  const [catsCollapsed, setCatsCollapsed] = useState(false);
  // 整体分析弹窗（遍历全部资源目录统计）。
  const [showAnalytics, setShowAnalytics] = useState(false);
  const activeCategory = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0]!;

  return (
    <div className={`weq-cache${catsCollapsed ? ' is-cats-collapsed' : ''}`}>
      {/* 左侧分类栏（可收起） */}
      {catsCollapsed ? (
        <div className="weq-cache-cats-rail">
          <button
            type="button"
            className="weq-cache-collapse-btn"
            onClick={() => setCatsCollapsed(false)}
            title="展开资源列表"
            aria-label="展开资源列表"
          >
            <PanelLeftOpen size={16} />
          </button>
          <button
            type="button"
            className="weq-cache-analyze-rail"
            onClick={() => setShowAnalytics(true)}
            title="整体分析"
            aria-label="整体分析"
          >
            <ChartPie size={16} />
          </button>
        </div>
      ) : (
        <nav className="weq-cache-cats" aria-label="缓存资源分类">
          <div className="weq-cache-cats-head">
            <span className="weq-cache-cats-title">资源</span>
            <button
              type="button"
              className="weq-cache-collapse-btn"
              onClick={() => setCatsCollapsed(true)}
              title="收起资源列表"
              aria-label="收起资源列表"
            >
              <PanelLeftClose size={16} />
            </button>
          </div>
          <button
            type="button"
            className="weq-cache-analyze-btn"
            onClick={() => setShowAnalytics(true)}
          >
            <ChartPie size={16} />
            <span>整体分析</span>
          </button>
          <div className="weq-cache-cats-body">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`weq-cache-cat${c.id === active ? ' is-active' : ''}`}
                onClick={() => setActive(c.id)}
              >
                <span className="weq-cache-cat-icon">{c.icon}</span>
                <span className="weq-cache-cat-text">
                  <strong>{c.label}</strong>
                  <small>{c.desc}</small>
                </span>
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* 右侧内容区 */}
      <section className="weq-cache-pane">
        {activeCategory.id === 'database' ? (
          <DbExplorer />
        ) : activeCategory.id === 'avatar' ? (
          <AvatarExplorer />
        ) : activeCategory.id === 'sysEmoji' ? (
          <SysEmojiExplorer />
        ) : activeCategory.id === 'marketEmoji' ? (
          <MarketEmojiExplorer />
        ) : activeCategory.id === 'customEmoji' ? (
          <CustomEmojiExplorer />
        ) : activeCategory.id === 'relatedEmoji' ? (
          <RelatedEmojiExplorer />
        ) : activeCategory.id === 'fileDir' ? (
          <FileDirExplorer />
        ) : activeCategory.id === 'downloadFile' ? (
          <DownloadFileExplorer />
        ) : activeCategory.id === 'album' ? (
          <FlatMediaExplorer key="album" kind="photoWall" />
        ) : activeCategory.id === 'qzone' ? (
          <FlatMediaExplorer key="qzone" kind="qzone" />
        ) : activeCategory.id === 'image' ? (
          <MonthMediaExplorer key="image" kind="pic" />
        ) : activeCategory.id === 'video' ? (
          <MonthMediaExplorer key="video" kind="video" />
        ) : activeCategory.id === 'voice' ? (
          <VoiceExplorer key="voice" />
        ) : (
          <CachePlaceholder label={activeCategory.label} />
        )}
      </section>

      <ResourceAnalyticsDialog open={showAnalytics} onClose={() => setShowAnalytics(false)} />
    </div>
  );
}

/** 未实现分类的占位空状态。 */
function CachePlaceholder({ label }: { label: string }): ReactElement {
  return (
    <div className="weq-cache-empty">
      <span className="weq-cache-empty-icon">
        <Construction size={30} strokeWidth={1.4} />
      </span>
      <strong className="weq-cache-empty-title">{label}</strong>
      <p className="weq-cache-empty-desc">
        该分类的查看与清理功能正在开发中，敬请期待。
      </p>
      <span className="weq-cache-empty-tag">开发中</span>
    </div>
  );
}
