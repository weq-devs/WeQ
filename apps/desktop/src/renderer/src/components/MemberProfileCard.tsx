// @ts-nocheck
/**
 * 用户资料卡片（贴光标弹出的 anchored popover）。
 *
 * 群聊里点击群成员列表某一行、私聊里点击对方消息头像时，在鼠标点击处弹出。
 * 群聊的基础信息（头像 / 群名片 / 角色 / 头衔 / 等级 / 入群时间）直接取自已在
 * 手的 GroupMember；QQ 号 / 昵称 / 性别 / 年龄 / 生日 / 签名 / 亲密度等
 * 「陌生人资料」字段异步走 account.getProfile(uid) 从 profile_info_v6 补全。
 * 视觉沿用好友资料灯箱（weq-profile-*）的设计语言，只是把居中灯箱换成贴光标的浮层。
 *
 * 个性主页、互动标识与互动画像统一在联系人页查看；右上角展开按钮可直达。
 * 从群成员列表进来时（带 groupCode）
 * 多一枚「查看聊天分析」，点开 {@link ./MemberAnalyticsDialog} —— 某人在**这个群**里的
 * 发言量 / 时段 / 常用语与表情。
 *
 * 浮层外壳（portal / 层级 / 拖拽打洞 / 点遮罩关闭）交给 {@link ./OverlayLayer}：
 * 卡片是贴光标的 anchored popover，必须 portal 到 body，**不能**为了「统一挂载」而
 * 改成 inline —— 祖先带 `backdrop-filter` / `transform` 会把 `position: fixed` 的包含块
 * 换掉，贴屏坐标当场失效。
 */
import {
  Award,
  BarChart3,
  Bot,
  Cake,
  CalendarDays,
  Check,
  Clock,
  Copy,
  Crown,
  Fingerprint,
  Hash,
  Heart,
  Loader2,
  MessageSquare,
  MessageSquareCode,
  Megaphone,
  Terminal,
  Shield,
  Sparkles,
  Star,
  User as UserIcon,
  Expand,
  Eye,
  X,
} from 'lucide-react';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '../im-template/template/types';
import { resolveAvatar } from '../lib/avatarResolver';
import { QzoneNavigationContext } from '../lib/qzoneNavigation';
import { client } from '../trpc/client';
import { ProfileLikesRow } from './qq-actions/ProfileLikesRow';
import { CommonRelationships } from './qq-actions/CommonRelationships';
import { MemberAnalyticsDialog } from './MemberAnalyticsDialog';
import { ContactWorkspaceNavigationContext } from '../lib/profileNavigation';
import type { AnalysisTarget } from '../views/analysis/model';
import { OverlayLayer } from './OverlayLayer';
import { QQGroupMemberControls } from './QQGroupMemberControls';
import { Avatar } from '../im-template/template/primitives';
import { VirtualConversationBadge } from './VirtualConversationAvatar';
import { cn } from '../im-template/template/classNames';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { displayUserName, displayGroupMemberName } from '../im-template/template/user';
import {
  ProfileRow,
  birthdayText,
  constellationOf,
  genderLabel,
} from '../im-template/template/profilePanes';

/** ISO 字符串 → zh-CN 年月日；无效 / 空 / epoch 返回 null。 */
function shortDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() <= 2000) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

const ROLE_META = {
  owner: { label: '群主', Icon: Crown, cls: 'is-owner' },
  admin: { label: '管理员', Icon: Shield, cls: 'is-admin' },
};

export function MemberProfileCard({
  member,
  anchor,
  onClose,
  groupCode,
  groupName,
  onOpenChat,
  onPreviewChat,
  previewContent,
  onAnalyze,
  localClone = Boolean(member.clone),
}: {
  member: User;
  anchor: { x: number; y: number };
  onClose: () => void;
  groupCode?: string;
  groupName?: string;
  onOpenChat?: () => void;
  onPreviewChat?: () => void;
  previewContent?: ReactNode;
  onAnalyze?: (target: AnalysisTarget) => void;
  /** 本地会话名片不读取源好友资料，不开放真实 QQ 操作或联系人跳转。 */
  localClone?: boolean;
}) {
  const openSpace = useContext(QzoneNavigationContext);
  const openWorkspace = useContext(ContactWorkspaceNavigationContext);
  const [loadedProfile, setProfile] = useState(null);
  const profile = localClone ? null : loadedProfile;
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [uidCopied, setUidCopied] = useState(false);
  // 「聊天分析」灯箱。只有从群成员列表进来时才有 groupCode —— 私聊里的资料卡不显示这个入口。
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  // 打开聊天分析后收起卡片本体，只保留分析页面。
  const [dismissed, setDismissed] = useState(false);
  // 机器人档案（profile_info_adelie）。QQ 只在客户端打开过该机器人资料卡后才
  // 写这张表，所以经常是 null —— 那时只展示 v6 那份普通资料。
  const [loadedBotProfile, setBotProfile] = useState(null);
  const botProfile = localClone ? null : loadedBotProfile;
  const cardRef = useRef(null);
  const [pos, setPos] = useState({ left: anchor.x + 14, top: anchor.y + 8, ready: false });

  // 自己的本地 id 可能是 self:<uin>；优先真实 uid，缺失时先按 QQ 号补资料。
  const lookupUid = localClone
    ? ''
    : member.uid || (member.id.startsWith('self:') ? '' : member.id);
  const uid = lookupUid || profile?.uid || '';
  const canAnalyze = !localClone && Boolean(groupCode && uid);

  // 补全陌生人资料字段。
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setProfile(null);
    if (localClone) {
      setLoading(false);
      return;
    }
    if (!lookupUid && !/^\d+$/.test(member.identityValue)) {
      setLoading(false);
      return;
    }
    // 查询身份只来自点击对象，补全得到的 UID 不应重新触发清空与读取。
    const pending = lookupUid
      ? client.account.getProfile.query({ uid: lookupUid })
      : client.account.getProfileByUin.query({ uin: member.identityValue });
    pending
      .then((p) => {
        if (alive) {
          setProfile(p);
          setLoading(false);
        }
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [lookupUid, member.identityValue, localClone]);

  // 机器人才去查 adelie 表；member.kind 来自 MainView 里的 botUids 集合。
  useEffect(() => {
    if (localClone || member.kind !== 'bot') {
      setBotProfile(null);
      return undefined;
    }
    let alive = true;
    client.account.getBotProfile
      .query({ uid })
      .then((p) => {
        if (alive) setBotProfile(p);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [uid, member.kind, localClone]);

  // 测量真实尺寸后把卡片夹在视口内：默认落在光标右下，右 / 下溢出则翻向左 / 上。
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const place = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const M = 10;
      let left = anchor.x + 14;
      let top = anchor.y + 8;
      if (left + w > vw - M) left = anchor.x - w - 14;
      left = Math.max(M, Math.min(left, vw - w - M));
      if (top + h > vh - M) top = vh - h - M;
      if (top < M) top = M;
      setPos((current) =>
        current.ready && current.left === left && current.top === top
          ? current
          : { left, top, ready: true },
      );
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(el);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor.x, anchor.y, loading, profile, botProfile, previewContent]);

  const name =
    !localClone && 'card' in member
      ? displayGroupMemberName(
          member.card,
          profile?.remark || member.remark,
          member.nick || profile?.nick,
          displayUserName(member),
        )
      : displayUserName(member);
  const role = ROLE_META[member.role];
  const uin = localClone
    ? null
    : profile?.uin && profile.uin !== '0'
      ? profile.uin
      : member.identityLabel === 'QQ'
        ? member.identityValue
        : null;
  // @、灰条等入口可能只有 UID；资料补全后统一补齐头像，也供下级灯箱复用。
  const avatarUrl =
    member.avatarUrl || resolveAvatar({ uin, profileAvatarUrl: profile?.avatarUrl });
  const nickDiffers = profile?.nick && profile.nick !== name && profile.nick !== member.remark;
  const gender = genderLabel(profile?.gender);
  const genderAge = [gender, profile?.age ? `${profile.age} 岁` : null].filter(Boolean).join(' · ');
  const zodiac = profile ? constellationOf(profile.birthMonth, profile.birthDay) : null;
  const birthday = profile
    ? birthdayText(profile.birthYear, profile.birthMonth, profile.birthDay)
    : null;
  const intimacy =
    profile?.intimacy && Number(profile.intimacy) > 0
      ? Number(profile.intimacy).toLocaleString('en-US')
      : null;
  // 群等级 = 数字等级（memberLevel）；levelName 是群主给各等级段起的段位名称
  // （元老 / 潜水 …），是「头衔样式」的字符串，只作为副标题附在数字后面，
  // 不能单独当等级展示——否则看起来就成了群头衔。
  const levelText = member.memberLevel
    ? `Lv.${member.memberLevel}${
        member.levelName && member.levelName !== `Lv${member.memberLevel}`
          ? ` · ${member.levelName}`
          : ''
      }`
    : member.levelName || null;
  const joinedAt = shortDate(member.joinedAt);
  const lastSpeak = shortDate(member.lastSpeakAt);
  const localId = member.id.startsWith('virtual:') ? member.id.slice('virtual:'.length) : member.id;

  async function copyLocalId() {
    if (await copyTextToClipboard(localId)) {
      setUidCopied(true);
      window.setTimeout(() => setUidCopied(false), 1500);
    }
  }

  async function copyUin() {
    if (!uin) return;
    const ok = await copyTextToClipboard(uin);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  async function copyUid() {
    const ok = await copyTextToClipboard(uid);
    if (ok) {
      setUidCopied(true);
      window.setTimeout(() => setUidCopied(false), 1500);
    }
  }

  return (
    <OverlayLayer
      presentation="popover"
      className="weq-member-pop-scrim"
      style={{ display: dismissed ? 'none' : undefined }}
      onClose={onClose}
    >
      <section
        ref={cardRef}
        className={cn('weq-member-pop weq-anim-pop', previewContent && 'is-previewing-chat')}
        style={{
          position: 'fixed',
          left: pos.left,
          top: pos.top,
          opacity: pos.ready ? 1 : 0,
        }}
        role="dialog"
        aria-label="用户资料"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {openWorkspace && !localClone ? (
          <button
            className="weq-profile-expand"
            type="button"
            title="展开联系人详情"
            aria-label="展开联系人详情"
            onClick={() => {
              onClose();
              openWorkspace({
                kind: 'person',
                contact: {
                  ...member,
                  ...profile,
                  id: uid || member.id || `uin:${uin}`,
                  uid: uid || undefined,
                  identityLabel: uin ? 'QQ' : member.identityLabel,
                  identityValue: uin || member.identityValue,
                  username: uid || member.username,
                  displayName: name,
                  avatarUrl,
                  createdAt: 'createdAt' in member ? member.createdAt : new Date(0).toISOString(),
                },
              });
            }}
          >
            <Expand size={16} />
          </button>
        ) : null}
        <button
          className="weq-profile-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={15} />
        </button>

        {previewContent ? (
          previewContent
        ) : (
          <>
            <div className="weq-profile-hero">
              <span
                className={cn('weq-profile-avatar', member.clone && 'weq-clone-profile-avatar')}
              >
                <Avatar name={name} avatarUrl={avatarUrl} seed={localClone ? member.id : uid} />
                {member.clone ? <VirtualConversationBadge /> : null}
              </span>
              <strong className="weq-profile-name">{name}</strong>
              {nickDiffers ? <span className="weq-profile-nick">昵称 {profile.nick}</span> : null}

              {uin ? (
                <button className="weq-profile-id" type="button" onClick={copyUin} title="点击复制">
                  <span>QQ</span>
                  <span className="weq-number">{uin}</span>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                </button>
              ) : null}

              {!localClone && (member.kind === 'bot' || role || genderAge || zodiac) ? (
                <div className="weq-profile-chips">
                  {member.kind === 'bot' ? (
                    <span className="weq-profile-rel is-bot">
                      <Bot size={13} strokeWidth={2.2} />
                      机器人
                    </span>
                  ) : null}
                  {role ? (
                    <span className={cn('weq-profile-rel', role.cls)}>
                      <role.Icon size={13} strokeWidth={2.2} />
                      {role.label}
                    </span>
                  ) : null}
                  {genderAge ? <span className="weq-profile-chip">{genderAge}</span> : null}
                  {zodiac ? (
                    <span className="weq-profile-chip">
                      <Sparkles size={12} />
                      {zodiac}
                    </span>
                  ) : null}
                </div>
              ) : null}

              {botProfile?.description || profile?.signature ? (
                <p className="weq-profile-sign">{botProfile?.description || profile.signature}</p>
              ) : null}
            </div>

            <div className="weq-profile-list">
              {localClone && member.clone ? (
                <ProfileRow
                  icon={<Hash size={13} />}
                  label="ID"
                  value={localId}
                  mono
                  action={
                    <button
                      className="weq-profile-row-copy"
                      type="button"
                      title="复制 ID"
                      aria-label="复制 ID"
                      onClick={copyLocalId}
                    >
                      {uidCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  }
                />
              ) : null}
              {!localClone && groupCode && uid ? (
                <QQGroupMemberControls
                  key={`${groupCode}:${uid}`}
                  groupCode={groupCode}
                  uid={uid}
                  profile={{ card: member.card, title: member.customTitle }}
                />
              ) : null}
              {levelText ? (
                <ProfileRow icon={<Award size={13} />} label="群等级" value={levelText} />
              ) : null}
              {birthday ? (
                <ProfileRow sensitive icon={<Cake size={13} />} label="生日" value={birthday} />
              ) : null}
              {intimacy ? (
                <ProfileRow
                  icon={<Heart size={13} />}
                  label="亲密度"
                  value={intimacy}
                  mono
                  accent
                />
              ) : null}
              {!localClone && member.kind !== 'bot' && uin ? (
                <>
                  <ProfileLikesRow uid={uid} uin={uin} name={displayUserName(member)} />
                  <CommonRelationships uin={uin} onNavigate={onClose} />
                </>
              ) : null}
              {joinedAt ? (
                <ProfileRow icon={<CalendarDays size={13} />} label="入群时间" value={joinedAt} />
              ) : null}
              {lastSpeak ? (
                <ProfileRow icon={<Clock size={13} />} label="最后发言" value={lastSpeak} />
              ) : null}
              {profile?.remark ? (
                <ProfileRow
                  sensitive
                  icon={<UserIcon size={13} />}
                  label="备注"
                  value={profile.remark}
                />
              ) : null}
              {profile?.qid ? (
                <ProfileRow
                  sensitive
                  icon={<Fingerprint size={13} />}
                  label="QID"
                  value={profile.qid}
                  mono
                />
              ) : null}
              {uid ? (
                <ProfileRow
                  icon={<Hash size={13} />}
                  label="UID"
                  sensitive
                  value={uid}
                  mono
                  action={
                    <button
                      className="weq-profile-row-copy"
                      type="button"
                      title="复制 UID"
                      aria-label="复制 UID"
                      onClick={copyUid}
                    >
                      {uidCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  }
                />
              ) : null}
              {botProfile?.wakeCommand ? (
                <ProfileRow
                  icon={<Terminal size={13} />}
                  label="唤醒指令"
                  value={botProfile.wakeCommand}
                  mono
                />
              ) : null}
            </div>

            {botProfile?.welcome ? (
              <div className="weq-bot-block">
                <div className="weq-bot-block-head">
                  <Megaphone size={13} />
                  欢迎语
                </div>
                <p className="weq-bot-welcome">{botProfile.welcome}</p>
              </div>
            ) : null}

            {botProfile?.commands?.length ? (
              <div className="weq-bot-block">
                <div className="weq-bot-block-head">
                  <MessageSquareCode size={13} />
                  支持的指令
                  <span className="weq-bot-cmd-count">{botProfile.commands.length}</span>
                </div>
                <ul className="weq-bot-cmds">
                  {botProfile.commands.map((c) => (
                    <li key={c.id} className="weq-bot-cmd">
                      <code>{c.command}</code>
                      {c.description ? <span>{c.description}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* 聊天分析看的是「这个人在这个群里」的发言，只认 uid + groupCode。 */}
            {uin || canAnalyze || onOpenChat || onPreviewChat ? (
              <div className="weq-profile-actions">
                {onOpenChat ? (
                  <button
                    className="weq-profile-perhome"
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenChat();
                    }}
                  >
                    <MessageSquare size={13} aria-hidden="true" />
                    查看私聊
                  </button>
                ) : null}
                {onPreviewChat ? (
                  <button
                    className="weq-profile-perhome"
                    type="button"
                    onClick={() => {
                      onPreviewChat();
                    }}
                  >
                    <Eye size={13} aria-hidden="true" />
                    预览私聊
                  </button>
                ) : null}
                {!localClone && uin && openSpace ? (
                  <button
                    className="weq-profile-perhome"
                    type="button"
                    onClick={() => {
                      onClose();
                      openSpace(uin, profile?.nick || name);
                    }}
                  >
                    <Star size={13} />
                    查看空间
                  </button>
                ) : null}
                {canAnalyze ? (
                  <button
                    className="weq-profile-perhome is-analytics"
                    type="button"
                    onClick={() => {
                      if (onAnalyze && groupCode) {
                        onAnalyze({
                          kind: 'member',
                          groupCode,
                          memberUid: uid,
                          memberUin: uin || undefined,
                        });
                        return;
                      }
                      setDismissed(true);
                      setAnalyticsOpen(true);
                    }}
                  >
                    <BarChart3 size={13} />
                    查看聊天分析
                  </button>
                ) : null}
              </div>
            ) : null}

            {loading ? (
              <div className="weq-member-loading">
                <Loader2 size={14} />
                <span>加载资料…</span>
              </div>
            ) : null}
          </>
        )}
      </section>

      {analyticsOpen && canAnalyze ? (
        <MemberAnalyticsDialog
          groupCode={groupCode}
          groupName={groupName || ''}
          member={{ uid, name, uin, avatarUrl }}
          onClose={() => {
            setAnalyticsOpen(false);
            onClose();
          }}
        />
      ) : null}
    </OverlayLayer>
  );
}
