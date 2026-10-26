// @ts-nocheck
/**
 * 位置共享面板 —— 发起 / 维持 / 查看一场实时位置共享。
 *
 * ## 生命周期
 *
 * 房间靠**上报心跳**续命（服务端在每次 `report` 的响应里给出下次间隔，实测 2 秒）；
 * 停止上报约 60 秒后服务端把房间标记为已结束。所以「退出共享」= 停掉心跳，
 * 没有单独的退出命令（真实客户端的结束动作走推送 ACK，第三方拿不到）。
 *
 * ## 三条命令
 *
 *   locationShareStart   建房间（私聊 / 群聊同一套，只有会话键不同）
 *   locationShareReport  周期上报自己的坐标
 *   locationShareQuery   拉所有成员坐标 —— **唯一**能拿到别人位置的途径
 *
 * ## 卡片
 *
 * 真实客户端发起后由服务端推一条「发起了位置共享」消息；WeQ 的 SSO 是「发一包
 * 就断」，服务端判定发起方不在线就不投递 —— 所以这里自己 `sendElements` 发卡片
 * （元素由 `buildShareLocationElements` 构造）。
 *
 * ## 为什么心跳在渲染层
 *
 * 主进程服务**不持有定时器**（见 `@weq/service` 的 `LocationShareService`）：谁打开
 * 了面板谁负责生命周期。面板卸载 / 切会话 / 关窗口时定时器随之清掉，不会有
 * 「关了界面还在后台偷偷上报位置」这种事。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Crosshair,
  Footprints,
  Gauge,
  MapPin,
  Play,
  Radio,
  Square,
  Users,
} from 'lucide-react';
import { cn } from './classNames';
import { client } from '../../trpc/client';
import { LocationShareMap, fitView, type MapMember, type MapView } from './locationShareMap';
import {
  JOYSTICK_SPEEDS,
  LocationShareJoystick,
  offsetLatLng,
  type JoystickSpeedId,
} from './locationShareJoystick';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from './locationPicker';

/** 心跳兜底间隔（服务端没给 interval 时）。 */
const DEFAULT_INTERVAL_SECONDS = 2;
/** 查询成员坐标的间隔（心跳的倍数）。位置不会推送，只能主动拉。 */
const QUERY_EVERY_TICKS = 3;
/** 摇杆驱动的重绘节拍（毫秒）：越小越顺滑，但上报仍然按服务端间隔。 */
const JOYSTICK_TICK_MS = 100;
/** 自己的坐标推送节流：摇杆移动时最多每这么多毫秒上报一次。 */
const REPORT_THROTTLE_MS = 900;

export type LocationSharePhase = 'idle' | 'starting' | 'active';

interface LocationSharePanelProps {
  /** 浮层根节点（外部点击判定用，与其余 composer 面板同构）。 */
  panelRef?: React.RefObject<HTMLDivElement | null>;
  /** c2c = 私聊，group = 群聊。 */
  scene: 'c2c' | 'group';
  /** 私聊：对端 QQ 号。群聊：群号。 */
  peer: number;
  /** 自己的 QQ 号。 */
  selfUin: number;
  /** 自己的显示名 / 头像（地图上自己的标记）。 */
  selfName: string;
  selfAvatarUrl?: string | null;
  selfUid?: string;
  /** 会话标题（面板头部）。 */
  conversationName: string;
  /** 群成员（用来把 uin 映射成昵称 / 头像）。私聊为空。 */
  members?: Array<{
    identityValue: string;
    displayName: string;
    avatarUrl: string | null;
    id: string;
  }>;
  /** 发送「发起了位置共享」卡片；由宿主转交 MessageSendService。 */
  onSendCard?: () => void | Promise<void>;
  /** 关闭面板（返回按钮）。 */
  onClose?: () => void;
  disabled?: boolean;
  disabledHint?: string;
}

/** 面板内的一次会话状态。 */
interface ShareSession {
  /** 我自己当前的坐标（摇杆 / 点地图会改它）。 */
  self: { longitude: number; latitude: number };
  /** 服务端要求的下次上报间隔（秒）。 */
  interval: number;
  /** 服务端返回的房间状态（1 进行中 / 2 已结束）。 */
  status: number;
  /** 最近一次拉到的成员（含自己）。 */
  members: Array<{
    uin: number;
    longitude: number;
    latitude: number;
    joinedAt: number;
    reportedAt: number;
  }>;
  /** 最近一次成功上报的时间（毫秒），用于「上次上报」提示。 */
  lastReportAt: number;
  /** 最近一次错误（展示用，成功一次就清）。 */
  error: string | null;
}

const EMPTY_SESSION: ShareSession = {
  self: { longitude: DEFAULT_CENTER.lng, latitude: DEFAULT_CENTER.lat },
  interval: DEFAULT_INTERVAL_SECONDS,
  status: 1,
  members: [],
  lastReportAt: 0,
  error: null,
};

/** uin → 展示信息（昵称 / 头像）。 */
type MemberInfo = { name: string; avatarUrl: string | null; uid?: string };

export function LocationSharePanel({
  panelRef,
  scene,
  peer,
  selfUin,
  selfName,
  selfAvatarUrl,
  selfUid,
  conversationName,
  members,
  onSendCard,
  onClose,
  disabled,
  disabledHint,
}: LocationSharePanelProps) {
  const [phase, setPhase] = useState<LocationSharePhase>('idle');
  const [session, setSession] = useState<ShareSession>(EMPTY_SESSION);
  const [speed, setSpeed] = useState<JoystickSpeedId>('walk');
  const [view, setView] = useState<MapView>({
    lng: DEFAULT_CENTER.lng,
    lat: DEFAULT_CENTER.lat,
    zoom: DEFAULT_ZOOM,
  });
  const [follow, setFollow] = useState(true);
  const [pickEnabled, setPickEnabled] = useState(false);
  /** 摇杆当前方向（-1..1），`null` = 没在移动。 */
  const moveRef = useRef<{ x: number; y: number } | null>(null);
  /** 每轮上报后的「下一次该报」计时。 */
  const nextReportRef = useRef(0);
  const lastReportSentRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  /** uin → 昵称 / 头像。群成员表优先，自己单独覆盖。 */
  const memberInfoByUin = useMemo(() => {
    const map = new Map<number, MemberInfo>();
    for (const member of members ?? []) {
      const uin = Number(member.identityValue);
      if (Number.isSafeInteger(uin) && uin > 0) {
        map.set(uin, {
          name: member.displayName,
          avatarUrl: member.avatarUrl,
          uid: member.id,
        });
      }
    }
    map.set(selfUin, { name: selfName, avatarUrl: selfAvatarUrl ?? null, uid: selfUid });
    return map;
  }, [members, selfUin, selfName, selfAvatarUrl, selfUid]);

  // ─────────────────────────── 启动 / 停止 ───────────────────────────

  const stopTicking = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  /** 上报一次（内部使用；会更新 session）。 */
  const doReport = useCallback(
    async (position: { longitude: number; latitude: number }) => {
      try {
        const reply = await client.account.locationShareReport.mutate({
          scene,
          peer,
          selfUin,
          longitude: position.longitude,
          latitude: position.latitude,
        });
        lastReportSentRef.current = Date.now();
        setSession((current) => ({
          ...current,
          interval: reply.interval || DEFAULT_INTERVAL_SECONDS,
          lastReportAt: Date.now(),
          error: reply.ok ? null : reply.message || `上报失败（${reply.code}）`,
        }));
      } catch (error) {
        setSession((current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    },
    [scene, peer, selfUin],
  );

  /** 拉一次成员坐标。 */
  const doQuery = useCallback(async () => {
    try {
      const room = await client.account.locationShareQuery.query({
        scene,
        peer,
        selfUin,
        mode: 1,
      });
      setSession((current) => ({
        ...current,
        status: room.status,
        members: room.members,
      }));
      // 房间已结束（停上报超时）→ 回到 idle，别让用户以为还在共享。
      if (room.status === 2 && phaseRef.current === 'active') {
        stopTicking();
        setPhase('idle');
      }
    } catch (error) {
      setSession((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [scene, peer, selfUin, stopTicking]);

  /**
   * 心跳循环。
   *
   * 用单个 100ms 的 tick 同时驱动「摇杆移动」与「按服务端间隔上报 / 定期查询」：
   * 两个独立定时器会让「摇杆停下但心跳还在跑」这类状态很难对齐。
   */
  const startTicking = useCallback(() => {
    stopTicking();
    let queryCountdown = 0;
    tickRef.current = setInterval(() => {
      if (phaseRef.current !== 'active') return;
      const now = Date.now();
      const current = sessionRef.current;

      // ① 摇杆位移：按速度档位把「米/秒」换成经纬度增量。
      const move = moveRef.current;
      if (move && (move.x !== 0 || move.y !== 0)) {
        const speedSpec = JOYSTICK_SPEEDS.find((item) => item.id === speed) ?? JOYSTICK_SPEEDS[0];
        const seconds = JOYSTICK_TICK_MS / 1000;
        const meters = speedSpec.metersPerSecond * seconds;
        // 屏幕 y 向下为正，地理上「向上」= 北。
        const next = offsetLatLng(
          current.self.latitude,
          current.self.longitude,
          -move.y * meters,
          move.x * meters,
        );
        setSession((prev) => ({ ...prev, self: next }));
        if (follow) setView((v) => ({ ...v, lng: next.longitude, lat: next.latitude }));
      }

      // ② 上报：到点才发，且摇杆移动时也不高于 REPORT_THROTTLE_MS。
      const intervalMs = Math.max(1000, current.interval * 1000);
      if (now >= nextReportRef.current && now - lastReportSentRef.current >= REPORT_THROTTLE_MS) {
        nextReportRef.current = now + intervalMs;
        const position = sessionRef.current.self;
        void doReport(position);
      }

      // ③ 查询：每 N 次上报拉一次成员坐标。
      queryCountdown -= 1;
      if (queryCountdown <= 0) {
        queryCountdown = QUERY_EVERY_TICKS;
        void doQuery();
      }
    }, JOYSTICK_TICK_MS);
  }, [speed, follow, doReport, doQuery, stopTicking]);

  // 摇杆 / 跟随 / 速度变了要重建 tick（闭包捕获了它们）。
  useEffect(() => {
    if (phase !== 'active') return;
    startTicking();
    return stopTicking;
  }, [phase, startTicking, stopTicking]);

  // 面板卸载时停心跳（等价于「退出共享」）。
  useEffect(() => stopTicking, [stopTicking]);

  const handleStart = useCallback(async () => {
    if (disabled) return;
    setPhase('starting');
    setSession((current) => ({ ...current, error: null }));
    const start = sessionRef.current.self;
    try {
      const reply = await client.account.locationShareStart.mutate({
        scene,
        peer,
        selfUin,
        longitude: start.longitude,
        latitude: start.latitude,
      });
      if (!reply.ok) {
        setSession((current) => ({
          ...current,
          error: reply.message || `发起失败（${reply.code}）`,
        }));
        setPhase('idle');
        return;
      }
      setPhase('active');
      nextReportRef.current = 0;
      lastReportSentRef.current = 0;
      setView((v) => ({ ...v, lng: start.longitude, lat: start.latitude }));
      // 发卡片：失败不影响共享本身（房间已经建好了）。
      try {
        await onSendCard?.();
      } catch {
        /* 卡片失败静默 —— 房间已建立，对方仍可通过其他方式加入 */
      }
    } catch (error) {
      setSession((current) => ({
        ...current,
        error: error instanceof Error ? error.message : String(error),
      }));
      setPhase('idle');
    }
  }, [disabled, scene, peer, selfUin, onSendCard]);

  const handleStop = useCallback(() => {
    stopTicking();
    setPhase('idle');
    moveRef.current = null;
  }, [stopTicking]);

  // ─────────────────────────── 交互 ───────────────────────────

  const handleJoystickMove = useCallback((dx: number, dy: number) => {
    moveRef.current = dx === 0 && dy === 0 ? null : { x: dx, y: dy };
  }, []);

  const handleMapPick = useCallback((longitude: number, latitude: number) => {
    setSession((current) => ({ ...current, self: { longitude, latitude } }));
    setPickEnabled(false);
    // 立刻上报一次，别等下一个心跳。
    lastReportSentRef.current = 0;
  }, []);

  /** 地图标记：房间成员 + 自己（自己以本地坐标为准，更实时）。 */
  const mapMembers: MapMember[] = useMemo(() => {
    const now = Date.now() / 1000;
    const result: MapMember[] = [];
    const selfPos = session.self;
    const seen = new Set<number>();
    for (const member of session.members) {
      if (member.uin === selfUin) continue;
      // 没上报过（坐标 0）的成员不画 —— 会落在几内亚湾。
      if (!member.longitude && !member.latitude) continue;
      const info = memberInfoByUin.get(member.uin);
      seen.add(member.uin);
      result.push({
        id: String(member.uin),
        name: info?.name ?? String(member.uin),
        avatarUrl: info?.avatarUrl ?? null,
        seed: info?.uid ?? String(member.uin),
        longitude: member.longitude,
        latitude: member.latitude,
        ageSeconds: member.reportedAt ? Math.max(0, now - member.reportedAt) : undefined,
      });
    }
    // 自己永远在（即使服务端还没回显）。
    result.push({
      id: 'self',
      name: selfName,
      avatarUrl: selfAvatarUrl ?? null,
      seed: selfUid ?? String(selfUin),
      longitude: selfPos.longitude,
      latitude: selfPos.latitude,
      isSelf: true,
    });
    return result;
  }, [session.members, session.self, selfUin, memberInfoByUin, selfName, selfAvatarUrl, selfUid]);

  /** 「看全部」：把所有标记收进视野。 */
  const handleFitAll = useCallback(() => {
    const host = document.querySelector('.lbs-map') as HTMLElement | null;
    const size = host
      ? { width: host.clientWidth, height: host.clientHeight }
      : { width: 360, height: 260 };
    const fitted = fitView(
      mapMembers.map((m) => ({ longitude: m.longitude, latitude: m.latitude })),
      size,
    );
    if (fitted) setView(fitted);
  }, [mapMembers]);

  /** 「回到我」。 */
  const handleRecenter = useCallback(() => {
    setFollow(true);
    setView((v) => ({ ...v, lng: session.self.longitude, lat: session.self.latitude }));
  }, [session.self]);

  const othersCount = session.members.filter(
    (m) => m.uin !== selfUin && (m.longitude || m.latitude),
  ).length;
  const active = phase === 'active';

  return (
    <div className={cn('lbs-panel', active && 'is-active')} ref={panelRef}>
      <header className={cn('lbs-header')}>
        <button type="button" className={cn('lbs-back')} title="返回" onClick={onClose}>
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <div className={cn('lbs-title')}>
          <MapPin size={15} strokeWidth={2.2} />
          <strong>位置共享</strong>
          <span className={cn('lbs-subtitle')}>{conversationName}</span>
        </div>
        <span className={cn('lbs-count')} title="共享中的成员">
          <Users size={13} strokeWidth={2} />
          {active ? othersCount + 1 : 0}
        </span>
      </header>

      {!active ? (
        <div className={cn('lbs-idle')}>
          <div className={cn('lbs-idle-art')} aria-hidden>
            <span className={cn('lbs-idle-ping')} />
            <MapPin size={30} strokeWidth={1.6} />
          </div>
          <p className={cn('lbs-idle-text')}>
            {scene === 'group' ? '和群成员互相看到彼此的位置' : '和对方互相看到彼此的位置'}
          </p>
          <button
            type="button"
            className={cn('lbs-primary')}
            disabled={disabled || phase === 'starting'}
            title={disabled ? disabledHint : '开始共享'}
            onClick={() => void handleStart()}
          >
            <Play size={15} strokeWidth={2.4} />
            {phase === 'starting' ? '发起中…' : '开始共享'}
          </button>
          {session.error ? <span className={cn('lbs-error')}>{session.error}</span> : null}
          {disabled && disabledHint ? <span className={cn('lbs-hint')}>{disabledHint}</span> : null}
        </div>
      ) : (
        <>
          <div className={cn('lbs-map-wrap')}>
            <LocationShareMap
              view={view}
              onViewChange={(next) => {
                setView(next);
                // 手动平移后不再自动跟随，避免和用户抢镜头。
                setFollow(false);
              }}
              members={mapMembers}
              onPick={handleMapPick}
              pickEnabled={pickEnabled}
            />
            <div className={cn('lbs-map-actions')}>
              <button
                type="button"
                className={cn('lbs-map-action', pickEnabled && 'is-on')}
                title={pickEnabled ? '取消选点' : '点击地图设置我的位置'}
                onClick={() => setPickEnabled((on) => !on)}
              >
                <Crosshair size={15} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className={cn('lbs-map-action', follow && 'is-on')}
                title="跟随我"
                onClick={() => {
                  setFollow((on) => !on);
                  if (!follow) handleRecenter();
                }}
              >
                <Radio size={15} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                className={cn('lbs-map-action')}
                title="看全部"
                onClick={handleFitAll}
              >
                <Gauge size={15} strokeWidth={2.2} />
              </button>
            </div>
          </div>

          <div className={cn('lbs-controls')}>
            <LocationShareJoystick onMove={handleJoystickMove} disabled={!active} />
            <div className={cn('lbs-speed')}>
              {JOYSTICK_SPEEDS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn('lbs-speed-chip', speed === item.id && 'is-on')}
                  title={`${item.label} · ${item.metersPerSecond} 米/秒`}
                  onClick={() => setSpeed(item.id)}
                >
                  {item.id === 'walk' ? <Footprints size={13} strokeWidth={2.2} /> : null}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <footer className={cn('lbs-footer')}>
            <span className={cn('lbs-status')}>
              <span className={cn('lbs-live-dot')} aria-hidden />
              {session.status === 2 ? '已结束' : '共享中'}
              {session.lastReportAt
                ? ` · ${Math.max(0, Math.round((Date.now() - session.lastReportAt) / 1000))}s 前上报`
                : ''}
            </span>
            <button type="button" className={cn('lbs-stop')} title="停止共享" onClick={handleStop}>
              <Square size={12} strokeWidth={2.6} />
              停止
            </button>
          </footer>
          {session.error ? <span className={cn('lbs-error')}>{session.error}</span> : null}
        </>
      )}
    </div>
  );
}
