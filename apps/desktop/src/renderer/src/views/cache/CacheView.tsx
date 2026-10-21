/**
 * 本地缓存资源中心（维护工具 → 本地缓存）。
 *
 * 布局：左侧竖向分类列表（按 表情 / 头像 / 图片与视频 / 文件 / 语音 / 空间
 * 分组）+ 右侧当前分类内容区，用于查看 nt_data 下的本地缓存。
 *
 * 数据库不在这里 —— 维护工具里已有独立的「数据库管理」入口；整体分析与批量
 * 清理也在维护工具里另有入口，这里不再重复放按钮。
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import {
  Image as ImageIcon,
  Images,
  Smile,
  Store,
  Sticker,
  PackageOpen,
  Folder,
  FileDown,
  Film,
  AudioLines,
  Cloud,
  Construction,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { AvatarExplorer } from './AvatarExplorer';
import { SysEmojiExplorer } from './SysEmojiExplorer';
import { MarketEmojiExplorer } from './MarketEmojiExplorer';
import { MarketPackExplorer } from './MarketPackExplorer';
import { CustomEmojiExplorer } from './CustomEmojiExplorer';
import { RelatedEmojiExplorer } from './RelatedEmojiExplorer';
import { FileDirExplorer } from './FileDirExplorer';
import { DownloadFileExplorer } from './DownloadFileExplorer';
import { FlatMediaExplorer, MonthMediaExplorer, VoiceExplorer } from './MediaResourceExplorers';
import '../../styles/cache.css';

/** 一个缓存资源分类。`ready` 为 false 时右侧渲染占位空状态。 */
interface CacheCategory {
  id: string;
  group: string;
  label: string;
  desc: string;
  icon: ReactNode;
  ready: boolean;
}

/**
 * 本地缓存的分类。数据库不在这里 —— 维护工具里已有独立的「数据库管理」，
 * 这里只收 nt_data 下按类型分的缓存资源，按 表情 / 头像 / 图片视频 / 文件 /
 * 语音 / 空间 分组。
 */
const CATEGORIES: CacheCategory[] = [
  {
    id: 'sysEmoji',
    group: '表情',
    label: '系统表情',
    desc: '内置表情资源',
    icon: <Smile size={18} />,
    ready: true,
  },
  {
    id: 'marketEmoji',
    group: '表情',
    label: '商城表情',
    desc: '商城下载的贴纸',
    icon: <Store size={18} />,
    ready: true,
  },
  {
    id: 'marketPack',
    group: '表情',
    label: '商城表情包',
    desc: '我添加的表情包 · 在线解密',
    icon: <PackageOpen size={18} />,
    ready: true,
  },
  {
    id: 'customEmoji',
    group: '表情',
    label: '自定义表情',
    desc: '收到的 / 我的表情',
    icon: <Sticker size={18} />,
    ready: true,
  },
  {
    id: 'relatedEmoji',
    group: '表情',
    label: '关联表情',
    desc: '关键词联想表情',
    icon: <Smile size={18} />,
    ready: true,
  },
  {
    id: 'avatar',
    group: '头像',
    label: '头像资源',
    desc: 'nt_data 头像缓存',
    icon: <ImageIcon size={18} />,
    ready: true,
  },
  {
    id: 'image',
    group: '图片与视频',
    label: '图片资源',
    desc: '聊天图片缓存',
    icon: <ImageIcon size={18} />,
    ready: true,
  },
  {
    id: 'video',
    group: '图片与视频',
    label: '视频资源',
    desc: '聊天视频缓存',
    icon: <Film size={18} />,
    ready: true,
  },
  {
    id: 'album',
    group: '图片与视频',
    label: '图片墙资源',
    desc: '群相册 / 图片墙缓存',
    icon: <Images size={18} />,
    ready: true,
  },
  {
    id: 'fileDir',
    group: '文件',
    label: 'File 目录',
    desc: 'nt_data File 目录',
    icon: <Folder size={18} />,
    ready: true,
  },
  {
    id: 'downloadFile',
    group: '文件',
    label: '下载文件',
    desc: '下载到本地的文件',
    icon: <FileDown size={18} />,
    ready: true,
  },
  {
    id: 'voice',
    group: '语音',
    label: '语音资源',
    desc: '聊天语音缓存',
    icon: <AudioLines size={18} />,
    ready: true,
  },
  {
    id: 'qzone',
    group: '空间',
    label: 'QQ空间缓存',
    desc: '空间浏览缓存',
    icon: <Cloud size={18} />,
    ready: true,
  },
];

export function CacheView(): ReactElement {
  const [active, setActive] = useState<string>(CATEGORIES[0]!.id);
  // 资源选择列可收起，收起后腾出空间给右侧内容区。
  const [catsCollapsed, setCatsCollapsed] = useState(false);
  // 静态账号在维护工具入口就被禁用（nt_data 属于本机在线账号，不属于快照），
  // 所以这里不需要再按账号类型裁剪分类。
  const activeCategory = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0]!;
  // 分类栏按组渲染：表情 / 头像 / 图片与视频 / 文件 / 语音 / 空间。
  const groups = CATEGORIES.reduce<Array<{ name: string; items: CacheCategory[] }>>(
    (acc, category) => {
      const last = acc.at(-1);
      if (last?.name === category.group) last.items.push(category);
      else acc.push({ name: category.group, items: [category] });
      return acc;
    },
    [],
  );

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
          <div className="weq-cache-cats-body">
            {groups.map((group) => (
              <div className="weq-cache-cat-group" key={group.name}>
                <span className="weq-cache-cat-group-label">{group.name}</span>
                {group.items.map((c) => (
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
            ))}
          </div>
        </nav>
      )}

      {/* 右侧内容区 */}
      <section className="weq-cache-pane">
        {activeCategory.id === 'avatar' ? (
          <AvatarExplorer />
        ) : activeCategory.id === 'sysEmoji' ? (
          <SysEmojiExplorer />
        ) : activeCategory.id === 'marketEmoji' ? (
          <MarketEmojiExplorer />
        ) : activeCategory.id === 'marketPack' ? (
          <MarketPackExplorer />
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
      <p className="weq-cache-empty-desc">当前版本暂不支持查看或清理该分类。</p>
      <span className="weq-cache-empty-tag">暂不支持</span>
    </div>
  );
}
