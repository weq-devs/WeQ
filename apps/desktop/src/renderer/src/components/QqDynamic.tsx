/**
 * QQ 动态提示卡 (elementType=26 / QQ_DYNAMIC, QQ 内部名 TOFU)。
 *
 * 好友说说、生日礼物提醒、装扮变更、匿名问答回复、密友绑定……一整类"资料/空间动态"
 * 通知共用这一个 element，靠 `dynamicType` 区分场景（真实枚举含义见
 * docs/database/nt_msg/elements/qq-dynamic.md，是全表扫描实测出来的，不是猜的）。
 *
 * 之前这里直接复用 ark 卡片的 `weq-ark-*` 视觉语言、只画了 mainDesc/封面/空间
 * logo 四个字段，是当前渲染里信息损耗最大的一块：
 *   - mainDesc/subDesc 各带一个十六进制颜色（QQ 原生拿来给文案上色），完全没用到；
 *   - 发布者只有 uin/uid，没有昵称头像，之前干脆不显示是谁；
 *   - dynamicMeta 里的跳转链接 (jumpUrl/jump_h5) 没接，卡片点了没反应；
 *   - dynamicTags（如生日祝福语、装扮好评语）整个没画；
 *   - dynamicType=11（互动认证/认识多久）正文其实压根不在 mainDesc 里，而是塞在
 *     dynamicMeta 一段 base64 编码的嵌套 protobuf 里，之前完全是空的。
 *
 * subDesc 颜色只做成强调色圆点/顶栏，不直接套在文字上——那是 QQ 给浅色气泡背景
 * 设计的颜色（样本里出现过 #000000/#03081A 这种深色文案色），直接当文字色在 WeQ
 * 深色主题下会读不清，正文统一走主题色。
 */

import { useEffect, useState, type ComponentType, type ReactElement } from 'react';
import {
  Bell,
  Gift,
  Heart,
  HelpCircle,
  Link2,
  Newspaper,
  Quote,
  Rss,
  Sparkles,
  ThumbsUp,
  Users,
} from 'lucide-react';
import { decode as decodeRawProto, type RawField } from '@weq/codec/raw';
import { cachedAvatarUrl } from '../lib/avatarCache';
import { QqAvatar } from './QqAvatar';
import { client } from '../trpc/client';

interface DynamicDesc {
  mainDesc?: string;
  subDesc?: string;
}

interface DynamicTag {
  flag48191?: boolean;
  tagId?: number;
  tagContent?: string;
}

/** dynamicType 真实枚举（扫描实测），未覆盖到的取值走 Rss 通用兜底。 */
const DYNAMIC_TYPE_META: Record<
  number,
  { label: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }
> = {
  1: { label: '个性签名', icon: Quote },
  2: { label: '说说动态', icon: Newspaper },
  6: { label: '生日提醒', icon: Gift },
  11: { label: '互动认证', icon: Users },
  13: { label: '匿名问答', icon: HelpCircle },
  15: { label: '节日提醒', icon: Bell },
  16: { label: '点赞提醒', icon: ThumbsUp },
  17: { label: '装扮变更', icon: Sparkles },
  18: { label: '互动提醒', icon: Heart },
  22: { label: '密友绑定', icon: Link2 },
};

/** dynamicMeta 的 JSON 形态里挑一个可点开的 https 链接（内部协议 jump_schema 打不开，忽略）。 */
function extractDynamicLink(meta: string | undefined): string | undefined {
  if (!meta) return undefined;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    for (const key of ['jumpUrl', 'jump_h5']) {
      const v = parsed[key];
      if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v;
    }
  } catch {
    /* 不是 JSON —— 走 base64 protobuf 分支，见 extractMetaHighlights */
  }
  return undefined;
}

/**
 * dynamicMeta 还可能是 base64 编码的嵌套 protobuf（目前只在 dynamicType=11 见过），
 * 没有专门建模（字段含义需要更多样本交叉验证）。这里用 codec 里 schema-free 的通用
 * 解码器把所有 UTF-8 叶子字符串捞出来做"尽力而为"展示——解不出来就什么都不显示，
 * 不影响卡片其余部分渲染，也绝不抛错。
 */
function extractMetaHighlights(meta: string | undefined): string[] {
  if (!meta || /^[{[]/.test(meta.trim())) return [];
  try {
    const bytes = Uint8Array.from(atob(meta), (c) => c.charCodeAt(0));
    const out: string[] = [];
    const walk = (fields: RawField[]): void => {
      for (const f of fields) {
        const g = f.guesses[0];
        if (!g) continue;
        if (g.kind === 'len-nested') walk(g.value);
        else if (g.kind === 'len-utf8') {
          const text = g.value.trim();
          if (text && text.length <= 40 && !/^https?:\/\//i.test(text)) out.push(text);
        }
      }
    };
    walk(decodeRawProto(bytes));
    return [...new Set(out)].slice(0, 6);
  } catch {
    return [];
  }
}

export function QqDynamic({
  dynamicType,
  desc,
  desc2,
  coverUrl,
  zoneLogoUrl,
  publisherUin,
  meta,
  tags,
}: {
  dynamicType?: number;
  desc?: DynamicDesc;
  desc2?: DynamicDesc;
  coverUrl?: string;
  zoneLogoUrl?: string;
  /** 实测可重复出现两次（如密友绑定场景，双方各自的 uin）；取第一个做展示身份。 */
  publisherUin?: number[];
  meta?: string;
  tags?: DynamicTag[];
}): ReactElement {
  const [coverBroken, setCoverBroken] = useState(false);
  const [publisher, setPublisher] = useState<{
    nick?: string;
    remark?: string;
    avatarUrl?: string;
  } | null>(null);

  const primaryUin = publisherUin?.[0];

  // 元素本身不带昵称/头像，只有 uin —— 按 uin 查一次已缓存的 profile 补全身份。
  // 查不到（陌生人/未缓存）就用「QQ号 xxx」兜底，绝不为了这一张卡片额外抓取。
  useEffect(() => {
    setPublisher(null);
    if (!primaryUin) return undefined;
    let alive = true;
    client.account.getProfileByUin
      .query({ uin: String(primaryUin) })
      .then((p) => {
        if (alive && p) setPublisher(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [primaryUin]);

  const typeMeta = dynamicType !== undefined ? DYNAMIC_TYPE_META[dynamicType] : undefined;
  const HeaderIcon = typeMeta?.icon ?? Rss;
  const headerLabel = typeMeta?.label ?? 'QQ动态';
  const accentColor = desc?.subDesc || '#8c8c8c';

  const headline = desc?.mainDesc?.trim() || headerLabel;
  const content = desc2?.mainDesc?.trim() || '';
  const publisherName =
    publisher?.remark || publisher?.nick || (primaryUin ? `QQ号 ${primaryUin}` : '');

  const jump = extractDynamicLink(meta);
  const highlights = extractMetaHighlights(meta);
  const onOpen = jump ? () => window.open(jump, '_blank') : undefined;

  return (
    <div
      className={onOpen ? 'weq-dynamic-container weq-dynamic-clickable' : 'weq-dynamic-container'}
      role={onOpen ? 'link' : undefined}
      title={onOpen ? jump : undefined}
      onClick={onOpen}
    >
      <div className="weq-dynamic-accent" style={{ background: accentColor }} />
      <div className="weq-dynamic-body">
        <div className="weq-dynamic-header">
          <HeaderIcon size={13} strokeWidth={2.2} />
          <span>{headline}</span>
        </div>

        {primaryUin ? (
          <div className="weq-dynamic-publisher">
            <QqAvatar uin={String(primaryUin)} url={publisher?.avatarUrl} size={28} />
            <span className="weq-dynamic-publisher-name">{publisherName}</span>
          </div>
        ) : null}

        {content ? <div className="weq-dynamic-content">{content}</div> : null}

        {coverUrl && !coverBroken ? (
          <img
            className="weq-dynamic-cover"
            src={cachedAvatarUrl(coverUrl) ?? coverUrl}
            alt=""
            loading="lazy"
            onError={() => setCoverBroken(true)}
          />
        ) : null}

        {highlights.length > 0 ? (
          <div className="weq-dynamic-highlights">
            {highlights.map((h) => (
              <span key={h} className="weq-dynamic-highlight-item">
                {h}
              </span>
            ))}
          </div>
        ) : null}

        {tags && tags.length > 0 ? (
          <div className="weq-dynamic-tags">
            {tags.map((t) => (
              <span
                key={`${t.tagId ?? ''}-${t.tagContent ?? ''}`}
                className={
                  t.flag48191 ? 'weq-dynamic-tag weq-dynamic-tag-highlight' : 'weq-dynamic-tag'
                }
              >
                {t.tagContent}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {zoneLogoUrl ? (
        <div className="weq-dynamic-footer">
          <img
            className="weq-dynamic-footer-icon"
            src={cachedAvatarUrl(zoneLogoUrl) ?? zoneLogoUrl}
            alt=""
            loading="lazy"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <span>QQ空间</span>
        </div>
      ) : null}
    </div>
  );
}
