/**
 * ARK 卡片渲染器（QQ 结构化卡片）。
 *
 * 从「猜布局」升级为「查表渲染」：卡片要显示的内容全在 `arkData.meta` 里，
 * `resolveArkCard`（见 arkCards.ts）按 QQ 官方资源包提取的字段绑定，把 meta 精确
 * 映射成语义槽位值（title/desc/thumb/cover/source/...），再按布局类型分发到少量手调的
 * 布局组件。已知常见卡精确渲染，未知/长尾卡走 generic（带槽位值，仍优于纯猜；再无
 * 槽位则退回启发式，保证不白屏）。
 *
 * 八个特例保留独立分支（不走通用槽位）：
 *   - 群公告 com.tencent.mannounce：title/text 为 base64、无图片素材。
 *   - 群活动 com.tencent.activity.md：带状态标签 + 按钮。
 *   - 公众号订阅消息 com.tencent.public.subscribe.standard (message)：appIcon+appName + infoItem 字段对 + operation 按钮。
 *   - QQ邮箱 com.tencent.template.public (mail)：title/subTitle/content 三段式显示。
 *   - plainText 通知 com.tencent.template.public (plainText)：头像昵称 + 标题摘要 + details 纯值列表 + operations 按钮。
 *   - 单图广告 com.tencent.template.public (singlePic)：大图 + 多行 label 叠加。
 *   - 安全提醒 com.tencent.security.message：设备风险警告 + 详情字段 + 底部链接。
 *   - QQ钱包 com.tencent.qianbao：title + content + informationList 标签对列表。
 *   - 位置分享 (lat/lng)：走 QQ 位置服务静态图（见 LocationCard，MAP_KEY 取自 QQ
 *     自己的 com.tencent.map 包），远程图统一走 weq-avatar:// 磁盘缓存。
 */

import { useMemo, type ReactElement, type ReactNode } from 'react';
import { MapPin, Megaphone, ShieldAlert } from 'lucide-react';
import { cachedAvatarUrl } from '../../lib/avatarCache';
import { resolveArkCard, type ArkValues } from './arkCards';

// ---- types ---------------------------------------------------------------

type ArkPayload = Record<string, unknown>;

interface ArkData {
  app?: string;
  prompt?: string;
  meta?: Record<string, ArkPayload>;
}

// ---- parsing helpers -----------------------------------------------------

function parseArkData(raw: unknown): ArkData | null {
  if (raw && typeof raw === 'object') return raw as ArkData;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as ArkData;
  } catch {
    return null;
  }
}

/** Read a string field off a payload (anything non-string → ''). */
function s(p: ArkPayload, key: string): string {
  const val = p[key];
  return typeof val === 'string' ? val : '';
}

/** Decode a base64 string as UTF-8 (atob yields Latin-1 bytes → TextDecoder). */
function decodeBase64Utf8(raw: string): string {
  try {
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return raw;
  }
}

/** 远程图片统一过 weq-avatar:// 磁盘缓存（满足 renderer CSP、避免重复回源）。 */
function arkImg(src?: string | null): string | undefined {
  if (!src) return undefined;
  return cachedAvatarUrl(src) ?? src;
}

/** 点击整卡打开链接：仅开 http(s)（忽略 mqqapi 等内部协议）。 */
function openHandler(jump?: string): (() => void) | undefined {
  const ok = !!jump && jump !== '#' && /^https?:\/\//i.test(jump);
  if (!ok) return undefined;
  return () => window.open(jump, '_blank');
}

// ---- shared shell --------------------------------------------------------

function ArkShell({
  jump,
  className,
  children,
  footer,
}: {
  jump?: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}): ReactElement {
  const onOpen = openHandler(jump);
  return (
    <div
      className={className ? `weq-ark-container ${className}` : 'weq-ark-container'}
      role={onOpen ? 'link' : undefined}
      title={onOpen ? jump : undefined}
      onClick={onOpen}
    >
      <div className="weq-ark-content">{children}</div>
      {footer}
    </div>
  );
}

function ArkFooter({ source, icon }: { source?: string; icon?: string }): ReactElement | null {
  if (!source && !icon) return null;
  return (
    <div className="weq-ark-footer">
      {icon ? <img className="weq-ark-footer-icon" src={arkImg(icon)} alt="" loading="lazy" /> : null}
      <span>{source}</span>
    </div>
  );
}

// ---- layout components ----------------------------------------------------

/** 名片：左头像 + 右昵称/副标题，底部来源标签（contact / cardshare / 名片分享变体）。 */
function ContactCard({ v }: { v: ArkValues }): ReactElement {
  return (
    <ArkShell jump={v.jump} className="weq-ark-contact" footer={<ArkFooter source={v.footerSource} icon={v.footerIcon} />}>
      <div className="weq-ark-contact-body">
        {v.avatar ? <img className="weq-ark-contact-avatar" src={arkImg(v.avatar)} alt="" loading="lazy" /> : null}
        <div className="weq-ark-contact-main">
          <div className="weq-ark-contact-name">{v.name || v.title || v.source || '推荐名片'}</div>
          {v.desc || v.summary ? <div className="weq-ark-contact-sub">{v.desc || v.summary}</div> : null}
        </div>
      </div>
    </ArkShell>
  );
}

/** 图文：标题在上，描述在左、缩略图在右，底部来源（图文/音乐/视频/结构化消息分享）。 */
function NewsCard({ v }: { v: ArkValues }): ReactElement {
  const thumb = v.thumb || v.cover;
  return (
    <ArkShell jump={v.jump} footer={<ArkFooter source={v.source} icon={v.sourceIcon} />}>
      {v.title ? <div className="weq-ark-title">{v.title}</div> : null}
      <div className="weq-ark-body-compact">
        <div className="weq-ark-desc">{v.desc || v.summary || ''}</div>
        {thumb ? <img className="weq-ark-preview-small" src={arkImg(thumb)} alt="" loading="lazy" /> : null}
      </div>
    </ArkShell>
  );
}

/** 应用块：顶部来源头（icon+名）/ 标题 / 通栏大图 / 底部来源（小程序）。 */
function AppBlockCard({ v }: { v: ArkValues }): ReactElement {
  const big = v.cover || v.thumb;
  const headerShown = !!v.source;
  // 顶部没来源文字时，把来源降级到底部展示，避免头部空白。
  const footerSource = v.footerSource || (headerShown ? '' : v.source);
  const footerIcon = v.footerIcon || (headerShown ? '' : v.sourceIcon);
  return (
    <ArkShell jump={v.jump} footer={<ArkFooter source={footerSource} icon={footerIcon} />}>
      {headerShown ? (
        <div className="weq-ark-header">
          {v.sourceIcon ? <img className="weq-ark-icon-app" src={arkImg(v.sourceIcon)} alt="" loading="lazy" /> : null}
          <span>{v.source}</span>
        </div>
      ) : null}
      {v.title ? <div className="weq-ark-title">{v.title}</div> : null}
      {v.desc ? (
        <div className="weq-ark-desc" style={{ marginBottom: big ? 8 : 0 }}>
          {v.desc}
        </div>
      ) : null}
      {big ? <img className="weq-ark-preview-big" src={arkImg(big)} alt="" loading="lazy" /> : null}
    </ArkShell>
  );
}

/** 媒体块：主文案 / 通栏封面 / 动作按钮 / 底部来源（一起听、一起看等）。 */
function MediaBlockCard({ v }: { v: ArkValues }): ReactElement {
  const big = v.cover || v.thumb;
  return (
    <ArkShell jump={v.jump} footer={<ArkFooter source={v.footerSource || v.source} icon={v.footerIcon || v.sourceIcon} />}>
      {v.summary || v.desc || v.title ? <div className="weq-ark-title">{v.summary || v.desc || v.title}</div> : null}
      {big ? <img className="weq-ark-preview-big" src={arkImg(big)} alt="" loading="lazy" /> : null}
      {v.button ? <div className="weq-ark-action-btn">{v.button}</div> : null}
    </ArkShell>
  );
}

/**
 * 通用卡：布局命不中具体类型时用。
 * ① 有槽位值 → 按大图/小图自动排版；② 无槽位值 → 退回启发式（保证不白屏）。
 */
function GenericCard({
  values,
  payload,
  prompt,
}: {
  values: ArkValues | null;
  payload: ArkPayload;
  prompt: string;
}): ReactElement {
  const hasSlots =
    !!values && !!(values.title || values.desc || values.summary || values.thumb || values.cover || values.name);
  if (values && hasSlots) {
    const small = values.thumb;
    const big = values.cover;
    return (
      <ArkShell jump={values.jump} footer={<ArkFooter source={values.source} icon={values.sourceIcon} />}>
        {values.title || values.name ? <div className="weq-ark-title">{values.title || values.name}</div> : null}
        {small ? (
          <div className="weq-ark-body-compact">
            <div className="weq-ark-desc">{values.desc || values.summary || ''}</div>
            <img className="weq-ark-preview-small" src={arkImg(small)} alt="" loading="lazy" />
          </div>
        ) : (
          <>
            {values.desc || values.summary ? (
              <div className="weq-ark-desc" style={{ marginBottom: big ? 8 : 0 }}>
                {values.desc || values.summary}
              </div>
            ) : null}
            {big ? <img className="weq-ark-preview-big" src={arkImg(big)} alt="" loading="lazy" /> : null}
          </>
        )}
        {values.button ? <div className="weq-ark-action-btn">{values.button}</div> : null}
      </ArkShell>
    );
  }
  return <HeuristicCard p={payload} prompt={prompt} />;
}

// ---- QQ邮箱通知卡 (com.tencent.template.public / view: mail) ----------------

/**
 * QQ邮箱通知卡。显示 title（发件人）、subTitle（邮件主题）、content（正文预览）。
 */
function ArkMail({ p }: { p: ArkPayload }): ReactElement {
  const title = s(p, 'title');
  const subTitle = s(p, 'subTitle');
  const content = s(p, 'content');
  const jumpUrl = s(p, 'mailUrl') || s(p, 'mailUrlByCode') || undefined;

  return (
    <ArkShell jump={jumpUrl}>
      {title ? <div className="weq-ark-title">{title}</div> : null}
      {subTitle ? <div className="weq-ark-desc" style={{ fontWeight: 500, marginBottom: 6 }}>{subTitle}</div> : null}
      {content ? <div className="weq-ark-desc" style={{ color: '#8c8c8c' }}>{content}</div> : null}
    </ArkShell>
  );
}

// ---- plainText 通知卡 (com.tencent.template.public / view: plainText) --------

/**
 * plainText 通知卡。显示头像+昵称、标题、摘要、详情字段对、底部操作按钮。
 * 用于功能内测通知等官方通知场景。只渲染字段值，不渲染键名（如 title1/desc1）。
 */
function ArkPlainText({ p }: { p: ArkPayload }): ReactElement {
  const avatar = s(p, 'avatar') || undefined;
  const nick = s(p, 'nick');
  const title = s(p, 'title');
  const summary = s(p, 'summary');

  // 提取 details 数组：[{desc1, title1}, {desc2, title2}, ...]
  // 只渲染 desc 值，忽略 title 键名
  const detailsArray = (p.details as Array<Record<string, unknown>> | undefined) || [];
  const detailItems: string[] = [];
  for (const detail of detailsArray) {
    for (let i = 1; i <= 10; i++) {
      const value = s(detail, `desc${i}`);
      if (value) detailItems.push(value);
    }
  }

  // 提取 operations 数组：[{label1, jumpUrl1}, ...]
  const operationsArray = (p.operations as Array<Record<string, unknown>> | undefined) || [];
  const operationItems: Array<{ label: string; url: string }> = [];
  for (const op of operationsArray) {
    for (let i = 1; i <= 5; i++) {
      const label = s(op, `label${i}`);
      const url = s(op, `jumpUrl${i}`);
      if (label && url) {
        operationItems.push({ label, url });
      }
    }
  }

  return (
    <div className="weq-ark-container">
      <div className="weq-ark-content">
        {/* 头部：头像 + 昵称 */}
        {(avatar || nick) ? (
          <div className="weq-ark-header" style={{ marginBottom: 8 }}>
            {avatar ? (
              <img className="weq-ark-icon-app" src={arkImg(avatar)} alt="" loading="lazy" />
            ) : null}
            <span style={{ fontWeight: 600 }}>{nick}</span>
          </div>
        ) : null}

        {/* 标题 */}
        {title ? <div className="weq-ark-title">{title}</div> : null}

        {/* 摘要 */}
        {summary ? (
          <div className="weq-ark-desc" style={{ marginBottom: detailItems.length > 0 ? 12 : 0 }}>
            {summary}
          </div>
        ) : null}

        {/* 详情列表（纯文本值） */}
        {detailItems.length > 0 ? (
          <div style={{ marginBottom: operationItems.length > 0 ? 12 : 0 }}>
            {detailItems.map((text, idx) => (
              <div key={idx} className="weq-ark-desc" style={{ marginBottom: 4 }}>
                {text}
              </div>
            ))}
          </div>
        ) : null}

        {/* 底部操作按钮 */}
        {operationItems.length > 0 ? (
          <div style={{ borderTop: '1px solid #e8e8e8', paddingTop: 8 }}>
            {operationItems.map((op, idx) => (
              <div
                key={idx}
                style={{
                  color: '#1677ff',
                  fontSize: 14,
                  cursor: 'pointer',
                  marginBottom: idx < operationItems.length - 1 ? 6 : 0,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(op.url, '_blank');
                }}
              >
                {op.label}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- 公众号订阅消息卡 (com.tencent.public.subscribe.standard / view: message) --

/**
 * 公众号订阅消息卡。显示 appIcon+appName、标题、正文、信息字段对（带标签）、底部操作按钮。
 * 用于会员到期提醒、订阅通知等场景。
 */
function ArkSubscribeMessage({ p }: { p: ArkPayload }): ReactElement {
  const appIcon = s(p, 'appIcon') || undefined;
  const appName = s(p, 'appName');
  const title = s(p, 'title');
  const contentText = s(p, 'contentText');
  const jumpUrl = s(p, 'jumpUrl') || s(p, 'appJumpUrl') || undefined;

  // 提取 infoItemTitle/infoItemDes 字段对
  const infoItems: Array<{ label: string; value: string }> = [];
  for (let i = 1; i <= 10; i++) {
    const label = s(p, `infoItemTitle${i}`);
    const value = s(p, `infoItemDes${i}`);
    if (label || value) {
      infoItems.push({ label, value });
    }
  }

  // 提取 operationText/operationJump 按钮
  const operations: Array<{ label: string; url: string; icon?: string }> = [];
  for (let i = 1; i <= 5; i++) {
    const label = s(p, `operationText${i}`);
    const url = s(p, `operationJump${i}`);
    const icon = s(p, `operationIcon${i}`) || undefined;
    if (label && url) {
      operations.push({ label, url, icon });
    }
  }

  return (
    <ArkShell jump={jumpUrl}>
      {/* 头部：appIcon + appName */}
      {(appIcon || appName) ? (
        <div className="weq-ark-header" style={{ marginBottom: 8 }}>
          {appIcon ? (
            <img className="weq-ark-icon-app" src={arkImg(appIcon)} alt="" loading="lazy" />
          ) : null}
          <span style={{ fontWeight: 600 }}>{appName}</span>
        </div>
      ) : null}

      {/* 标题 */}
      {title ? <div className="weq-ark-title">{title}</div> : null}

      {/* 正文 */}
      {contentText ? (
        <div className="weq-ark-desc" style={{ marginBottom: infoItems.length > 0 ? 12 : 0 }}>
          {contentText}
        </div>
      ) : null}

      {/* 信息字段对列表 */}
      {infoItems.length > 0 ? (
        <div style={{ marginBottom: operations.length > 0 ? 12 : 0 }}>
          {infoItems.map((item, idx) => (
            <div key={idx} style={{ marginBottom: 8 }}>
              {item.label ? (
                <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 2 }}>{item.label}</div>
              ) : null}
              {item.value ? (
                <div style={{ fontSize: 14, color: '#000', fontWeight: 500 }}>{item.value}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* 底部操作按钮 */}
      {operations.length > 0 ? (
        <div style={{ borderTop: '1px solid #e8e8e8', paddingTop: 8 }}>
          {operations.map((op, idx) => (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                color: '#1677ff',
                fontSize: 14,
                cursor: 'pointer',
                marginBottom: idx < operations.length - 1 ? 6 : 0,
              }}
              onClick={(e) => {
                e.stopPropagation();
                window.open(op.url, '_blank');
              }}
            >
              {op.icon ? (
                <img src={arkImg(op.icon)} alt="" style={{ width: 16, height: 16 }} loading="lazy" />
              ) : null}
              <span>{op.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </ArkShell>
  );
}

// ---- 单图广告卡 (com.tencent.template.public / view: singlePic) -------------

/**
 * 单图广告卡。通栏大图 + 下方叠加多行文本标签（label1, label2, ...）。
 *
 * 「访问了你」这类纯文案变体 banner/singlePicItems 里的字段全是空字符串，槽位
 * 兜底不到东西就只能落回顶层 prompt（如 "H3CoF6访问了你"），否则渲染出空气泡。
 */
function ArkSinglePic({ p, prompt }: { p: ArkPayload; prompt: string }): ReactElement {
  const banner = s(p, 'banner');
  const bannerUrl = s(p, 'bannerUrl') || undefined;

  // 收集 singlePicItems 数组里的 label1/text1 等（如果有多个项）
  const items = (p.singlePicItems as Array<Record<string, unknown>> | undefined) || [];
  const labels: string[] = [];

  // 优先从数组项提取
  for (const item of items) {
    const label = s(item, 'label1') || s(item, 'text1');
    if (label) labels.push(label);
  }

  // 兜底：直接从 p 里取 label1, label2, label3...
  if (labels.length === 0) {
    for (let i = 1; i <= 5; i++) {
      const label = s(p, `label${i}`);
      if (label) labels.push(label);
    }
  }

  // 如果 banner 和 labels 都为空，至少显示 prompt（p.prompt 几乎总是空——真正
  // 有内容的是顶层 data.prompt，通过参数传进来）
  const hasContent = banner || labels.length > 0;
  const fallbackText = s(p, 'prompt') || prompt;

  return (
    <ArkShell jump={bannerUrl}>
      {banner ? <img className="weq-ark-preview-big" src={arkImg(banner)} alt="" loading="lazy" /> : null}
      {labels.length > 0 ? (
        <div style={{ marginTop: banner ? 8 : 0 }}>
          {labels.map((label, idx) => (
            <div key={idx} className="weq-ark-desc" style={{ marginBottom: idx < labels.length - 1 ? 4 : 0 }}>
              {label}
            </div>
          ))}
        </div>
      ) : null}
      {!hasContent && fallbackText ? <div className="weq-ark-desc">{fallbackText}</div> : null}
    </ArkShell>
  );
}

// ---- 安全提醒卡 (com.tencent.security.message / view: message) -------------

/**
 * 安全提醒卡。显示设备风险警告：顶部文字 + 多个详情字段（detail_title/content）+ 底部链接。
 */
function ArkSecurityMessage({ p }: { p: ArkPayload }): ReactElement {
  const title = s(p, 'title');
  const topText = s(p, 'topText');
  const headerIcon = s(p, 'headerIcon') || undefined;
  const details = (p.details as Array<Record<string, unknown>> | undefined) || [];
  const links = (p.links as Array<Record<string, unknown>> | undefined) || [];

  // 收集所有有效的详情字段（detail_title1/content1, detail_title2/content2, ...）
  const detailItems: Array<{ title: string; content: string; color?: string }> = [];
  for (const detail of details) {
    // 尝试 detail_title1/content1, detail_title2/content2, ... 直到找不到
    for (let i = 1; i <= 7; i++) {
      const detailTitle = s(detail, `detail_title${i}`);
      const detailContent = s(detail, `detail_content${i}`);
      const detailColor = s(detail, `detail_color${i}`) || undefined;
      if (detailTitle || detailContent) {
        detailItems.push({ title: detailTitle, content: detailContent, color: detailColor });
      }
    }
  }

  // 收集底部链接（link_title1/url1, link_title2/url2, ...）
  const linkItems: Array<{ title: string; url: string }> = [];
  for (const link of links) {
    for (let i = 1; i <= 5; i++) {
      const linkTitle = s(link, `link_title${i}`);
      const linkUrl = s(link, `link_url${i}`);
      if (linkTitle && linkUrl) {
        linkItems.push({ title: linkTitle, url: linkUrl });
      }
    }
  }

  return (
    <div className="weq-ark-container weq-ark-security">
      <div className="weq-ark-content">
        {/* 头部：图标 + 标题 */}
        <div className="weq-ark-header" style={{ marginBottom: 8 }}>
          {headerIcon ? (
            <img className="weq-ark-icon-app" src={arkImg(headerIcon)} alt="" loading="lazy" />
          ) : (
            <ShieldAlert className="weq-ark-security-icon" size={16} strokeWidth={2.2} />
          )}
          <span style={{ fontWeight: 600 }}>{title || '安全提醒'}</span>
        </div>

        {/* 顶部警告文字 */}
        {topText ? (
          <div className="weq-ark-desc" style={{ marginBottom: 12, lineHeight: 1.5 }}>
            {topText}
          </div>
        ) : null}

        {/* 详情字段列表 */}
        {detailItems.length > 0 ? (
          <div style={{ marginBottom: 12 }}>
            {detailItems.map((item, idx) => (
              <div key={idx} style={{ marginBottom: 8 }}>
                {item.title ? (
                  <div style={{ fontSize: 12, color: '#8c8c8c', marginBottom: 2 }}>{item.title}</div>
                ) : null}
                {item.content ? (
                  <div style={{ fontSize: 14, color: item.color || '#000', fontWeight: 500 }}>{item.content}</div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {/* 底部链接 */}
        {linkItems.length > 0 ? (
          <div style={{ borderTop: '1px solid #e8e8e8', paddingTop: 8 }}>
            {linkItems.map((link, idx) => (
              <div
                key={idx}
                style={{
                  color: '#1677ff',
                  fontSize: 14,
                  cursor: 'pointer',
                  marginBottom: idx < linkItems.length - 1 ? 6 : 0,
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  window.open(link.url, '_blank');
                }}
              >
                {link.title}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---- QQ钱包通知卡 (com.tencent.qianbao / view: genericMessageView) ----------

/**
 * QQ钱包通知卡。显示 title + content + informationList（标签-文本对列表）。
 */
function ArkQianBaoMessage({ p }: { p: ArkPayload }): ReactElement {
  const title = s(p, 'title');
  const content = s(p, 'content');
  const informationList = (p.informationList as Array<Record<string, unknown>> | undefined) || [];

  return (
    <ArkShell>
      {title ? <div className="weq-ark-title">{title}</div> : null}
      {content ? <div className="weq-ark-desc" style={{ marginBottom: informationList.length > 0 ? 12 : 0 }}>{content}</div> : null}
      {informationList.length > 0 ? (
        <div style={{ borderTop: '1px solid #e8e8e8', paddingTop: 8 }}>
          {informationList.map((item, idx) => {
            const label = s(item, 'label');
            const text = s(item, 'text');
            if (!label && !text) return null;
            return (
              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, color: '#8c8c8c' }}>{label}</span>
                <span style={{ fontSize: 13, color: '#000' }}>{text}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </ArkShell>
  );
}

// ---- 群报名/活动卡 (com.tencent.activity.md) --------------------------------

function ArkActivity({ p }: { p: ArkPayload }): ReactElement {
  const title = s(p, 'title');
  const desc = s(p, 'desc');
  const isEnabled = p.isEnabled === true;
  const statusLabel = isEnabled ? s(p, 'ongoingStatusLabel') : '已结束';
  const joinLabel = s(p, 'joinLabel');
  const freeLabel = s(p, 'freeLabel');
  const buttonText = s(p, 'buttonText') || '查看详情';
  const tag = s(p, 'tag');
  const tagIcon = s(p, 'tagIcon') || undefined;
  const jumpUrl = s(p, 'jumpUrl') || undefined;

  return (
    <ArkShell jump={jumpUrl} footer={<ArkFooter source={tag} icon={tagIcon} />}>
      {title ? <div className="weq-ark-title">{title}</div> : null}
      {desc ? <div className="weq-ark-desc weq-ark-activity-desc">{desc}</div> : null}
      <div className="weq-ark-activity-meta">
        {statusLabel ? <span className="weq-ark-activity-badge">{statusLabel}</span> : null}
        {joinLabel ? <span className="weq-ark-activity-badge">{joinLabel}</span> : null}
        {freeLabel ? <span className="weq-ark-activity-badge">{freeLabel}</span> : null}
      </div>
      {buttonText ? <div className="weq-ark-activity-btn">{buttonText}</div> : null}
    </ArkShell>
  );
}

// ---- 群公告 (com.tencent.mannounce) --------------------------------------

/**
 * 群公告卡。payload 里 title/text 为 base64 (encode=1)、无图片素材，不复用通用引擎。
 * title 实为头部标签（如「群公告」），text 才是正文（保留换行）。卡片不可点击。
 */
function ArkGroupAnnounce({ p }: { p: ArkPayload }): ReactElement {
  const encoded = p.encode === 1 || p.encode === '1';
  const decode = (raw: string): string => (encoded ? decodeBase64Utf8(raw) : raw);
  const title = decode(s(p, 'title')).trim() || '群公告';
  const text = decode(s(p, 'text')).trim();
  return (
    <div className="weq-ark-container weq-ark-announce">
      <div className="weq-ark-content">
        <div className="weq-ark-header">
          <Megaphone className="weq-ark-announce-icon" size={14} strokeWidth={2.2} />
          <span>{title}</span>
        </div>
        {text ? <div className="weq-ark-announce-text">{text}</div> : null}
      </div>
    </div>
  );
}

// ---- 位置分享 (QQ 位置服务静态图) ----------------------------------------

/**
 * MAP_KEY 取自 QQ 自己的 com.tencent.map ark 包，对同一 staticmap/v2 端点画缩略图，
 * 像素级一致。共享 key：本地渲染够用，大流量公用可能被限速。
 */
const QQ_MAP_KEY = 'RJNBZ-56724-USWUA-XVB56-RWETV-AIBPS';

function qqStaticMapUrl(lat: string, lng: string): string {
  const q = new URLSearchParams({
    key: QQ_MAP_KEY,
    size: '280*130',
    center: `${lat},${lng}`,
    zoom: '16',
    format: 'png8',
    no_logo: '1',
    scale: '2',
  });
  return `https://apis.map.qq.com/ws/staticmap/v2/?${q.toString()}`;
}

function ArkLocation({
  lat,
  lng,
  name,
  address,
  jump,
}: {
  lat: string;
  lng: string;
  name: string;
  address: string;
  jump?: string;
}): ReactElement {
  const mapSrc = lat && lng ? cachedAvatarUrl(qqStaticMapUrl(lat, lng)) : null;
  const onOpen = openHandler(jump);
  return (
    <div
      className="weq-ark-container"
      role={onOpen ? 'link' : undefined}
      title={onOpen ? jump : undefined}
      onClick={onOpen}
    >
      <div className="weq-ark-content">
        {name ? <div className="weq-ark-title">{name}</div> : null}
        {address ? <div className="weq-ark-desc" style={{ color: '#8c8c8c', marginBottom: 8 }}>{address}</div> : null}
        <div className="weq-ark-map-view">
          {mapSrc ? (
            <img
              className="weq-ark-map-img"
              src={mapSrc}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : null}
          <MapPin className="weq-ark-map-pin" size={28} strokeWidth={2.2} />
          {name ? <span className="weq-ark-map-name">{name}</span> : null}
        </div>
      </div>
    </div>
  );
}

// ---- 启发式兜底引擎（原通用引擎，未知卡最后的防线，保证不白屏） ------------

function HeuristicCard({ p, prompt }: { p: ArkPayload; prompt: string }): ReactElement {
  const appIcon = s(p, 'icon') || null;
  const footerIcon = s(p, 'tagIcon') || null;
  const mainImg = s(p, 'preview') || s(p, 'cover') || s(p, 'img') || s(p, 'avatar') || null;
  const actionBtnText = s(p, 'button') || null;
  const jumpUrl = s(p, 'jumpUrl') || s(p, 'qqdocurl') || s(p, 'url') || s(p, 'link') || '#';

  let header = '';
  let title = s(p, 'title') || s(p, 'summary') || s(p, 'nickname') || prompt || '';
  let desc = s(p, 'desc') || s(p, 'contact') || s(p, 'address') || '';
  if (appIcon || p.appid) {
    header = s(p, 'title');
    title = s(p, 'desc');
    desc = s(p, 'summary');
  } else if (s(p, 'nickname')) {
    header = s(p, 'tag') || '推荐联系人';
  }
  if (s(p, 'title') && s(p, 'summary') && s(p, 'title').includes('听歌')) {
    title = s(p, 'summary');
    desc = s(p, 'title');
  }

  const isBlockLayout = !!(s(p, 'cover') || (appIcon && s(p, 'preview')) || actionBtnText);
  const isCompactLayout = !!(mainImg && !isBlockLayout);

  let footerLabel = s(p, 'tag') || s(p, 'subTitle') || '';
  if (!footerLabel && prompt) {
    footerLabel = prompt.match(/^\[(.*?)\]/)?.[1] ?? '应用分享';
  }

  return (
    <ArkShell
      jump={jumpUrl}
      footer={<ArkFooter source={footerLabel} icon={footerIcon ?? undefined} />}
    >
      {header || appIcon ? (
        <div className="weq-ark-header">
          {appIcon ? <img className="weq-ark-icon-app" src={arkImg(appIcon)} alt="" loading="lazy" /> : null}
          <span>{header}</span>
        </div>
      ) : null}
      {title ? <div className="weq-ark-title">{title}</div> : null}
      {isCompactLayout ? (
        <div className="weq-ark-body-compact">
          <div className="weq-ark-desc">{desc}</div>
          {mainImg ? <img className="weq-ark-preview-small" src={arkImg(mainImg)} alt="" loading="lazy" /> : null}
        </div>
      ) : (
        <>
          {desc ? (
            <div className="weq-ark-desc" style={{ marginBottom: 8 }}>
              {desc}
            </div>
          ) : null}
          {isBlockLayout && mainImg ? (
            <img className="weq-ark-preview-big" src={arkImg(mainImg)} alt="" loading="lazy" />
          ) : null}
        </>
      )}
      {actionBtnText ? <div className="weq-ark-action-btn">{actionBtnText}</div> : null}
    </ArkShell>
  );
}

// ---- entry ---------------------------------------------------------------

export function QqArk({ arkData }: { arkData: unknown }): ReactElement | null {
  const data = useMemo(() => parseArkData(arkData), [arkData]);

  const firstKey = data?.meta ? Object.keys(data.meta)[0] : undefined;
  const p: ArkPayload | null = data?.meta && firstKey ? data.meta[firstKey] ?? null : null;
  if (!data || !p) return null;

  const app = typeof data.app === 'string' ? data.app : '';
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';

  // 特例1：群公告。
  if (app === 'com.tencent.mannounce') return <ArkGroupAnnounce p={p} />;

  // 特例2：群报名/活动。
  if (app === 'com.tencent.activity.md') return <ArkActivity p={p} />;

  // 特例2.5：公众号订阅消息 (com.tencent.public.subscribe.standard / view: message)。
  if (app === 'com.tencent.public.subscribe.standard' && firstKey === 'message') {
    return <ArkSubscribeMessage p={p} />;
  }

  // 特例3：QQ邮箱通知 (view: mail)。
  if (app === 'com.tencent.template.public' && firstKey === 'mail') return <ArkMail p={p} />;

  // 特例3.5：plainText 通知卡 (view: plainText)。
  if (app === 'com.tencent.template.public' && firstKey === 'plainText') return <ArkPlainText p={p} />;

  // 特例4：单图广告 (view: singlePic)。
  if (app === 'com.tencent.template.public' && firstKey === 'singlePic') return <ArkSinglePic p={p} prompt={prompt} />;

  // 特例5：安全提醒卡。
  if (app === 'com.tencent.security.message') return <ArkSecurityMessage p={p} />;

  // 特例6：QQ钱包通知卡。
  if (app === 'com.tencent.qianbao') return <ArkQianBaoMessage p={p} />;

  // 特例7：位置分享（任何带 lat/lng 的卡都走静态地图）。
  const lat = s(p, 'lat');
  const lng = s(p, 'lng');
  if (lat && lng) {
    return (
      <ArkLocation
        lat={lat}
        lng={lng}
        name={s(p, 'name')}
        address={s(p, 'address') || s(p, 'desc')}
        jump={s(p, 'jumpUrl') || s(p, 'qqdocurl') || s(p, 'url') || undefined}
      />
    );
  }

  const { layout, values } = resolveArkCard(app, data.meta ?? {});
  switch (layout) {
    case 'contact':
      return <ContactCard v={values!} />;
    case 'news':
      return <NewsCard v={values!} />;
    case 'appBlock':
      return <AppBlockCard v={values!} />;
    case 'mediaBlock':
      return <MediaBlockCard v={values!} />;
    default:
      return <GenericCard values={values} payload={p} prompt={prompt} />;
  }
}
