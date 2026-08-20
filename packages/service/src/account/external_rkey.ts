/**
 * ExternalRkeyService — 外部 rkey 服务器的全局入口。
 *
 * 与账号 rkey 的关系：媒体下载时优先用「本机在线 QQ 自己获取的 rkey」（存在
 * AccountConfig 里），本地没有或全部过期时才回退到这里。这里的配置是全局的
 * （AppSettings.externalRkey），rkey 与账号权限关系不大，一份配置所有账号通用。
 *
 * 全局 rkey 存储：每次向服务器拉取成功会把 private/group 两条 rkey 与过期时间
 * 缓存回配置（config.json）。下载时先查缓存，未过期直接用，过期才重新拉取，
 * 这样 QQ 进程不在线的机器也能持续补全媒体。
 *
 * 只产出图片 rkey（type 10/20）：视频、文件、语音走的是另一套协议，外部服务器
 * 也拿不到，见 media_download.ts 的说明。
 */

import type { UserConfigService } from '../bootstrap/user_config';
import type { ExternalRkeyServerConfig } from '../bootstrap/user_config';
import type { DownloadRkey } from './user_config';
import { fetchNapcatRkeys, type NapcatRkeyServerResult } from './rkey_server';
import { getLogger } from '../common/logger';

/** 外部服务器能提供的 rkey 类型：10 = 私聊图片，20 = 群聊图片。 */
const EXTERNAL_RKEY_TYPES = [10, 20];

export class ExternalRkeyService {
  private readonly logger = getLogger().child({ scope: 'external-rkey' });

  constructor(private readonly userConfig: UserConfigService) {}

  /** 当前启用的服务器配置；未启用任何服务器时返回 null。 */
  enabledServer(): ExternalRkeyServerConfig | null {
    const cfg = this.userConfig.getSettings().externalRkey;
    if (!cfg.enabledServerId) return null;
    return cfg.servers.find((s) => s.id === cfg.enabledServerId) ?? null;
  }

  /**
   * 解析外部服务器当前可用的 rkey（过滤 allowedTypes 后）。先命中全局缓存，
   * 未过期直接返回；缓存缺失/过期则拉取一次并缓存。拉取失败返回空数组，
   * 由调用方继续走其它兜底，不会抛错打断下载。
   */
  async resolveRkeys(allowedTypes: number[]): Promise<DownloadRkey[]> {
    const server = this.enabledServer();
    if (!server) return [];
    const allow = new Set(allowedTypes);
    const wanted = EXTERNAL_RKEY_TYPES.filter((type) => allow.has(type));
    if (wanted.length === 0) return [];

    const cached = this.cachedRkeys(server, wanted);
    if (cached.length > 0) return cached;

    try {
      const result = await fetchNapcatRkeys(server.baseUrl, server.accessToken);
      this.persistCache(server.id, result);
      return toRkeys(result, wanted);
    } catch (e) {
      this.logger.warn('external rkey fetch failed', {
        event: 'external-rkey-fetch-failed',
        serverId: server.id,
        error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  /** 测试连接（只探测，不写缓存）。失败抛 Error（带原因）。 */
  test(baseUrl: string, accessToken: string): Promise<NapcatRkeyServerResult> {
    return fetchNapcatRkeys(baseUrl, accessToken);
  }

  private cachedRkeys(server: ExternalRkeyServerConfig, wanted: number[]): DownloadRkey[] {
    const nowSec = Date.now() / 1000;
    if (server.expiredTime == null || server.expiredTime <= nowSec) return [];
    const out: DownloadRkey[] = [];
    if (wanted.includes(10) && server.privateRkey) {
      out.push(toRkey(10, server.privateRkey, server.expiredTime));
    }
    if (wanted.includes(20) && server.groupRkey) {
      out.push(toRkey(20, server.groupRkey, server.expiredTime));
    }
    return out;
  }

  private persistCache(serverId: string, result: NapcatRkeyServerResult): void {
    const cfg = this.userConfig.getSettings().externalRkey;
    const servers = cfg.servers.map((s) =>
      s.id === serverId
        ? {
            ...s,
            privateRkey: result.privateRkey,
            groupRkey: result.groupRkey,
            expiredTime: result.expiredTime,
            fetchedAt: Date.now(),
          }
        : s,
    );
    this.userConfig.setSettings({
      externalRkey: { servers, enabledServerId: cfg.enabledServerId },
    });
    this.logger.info('cached external rkeys', {
      event: 'external-rkey-cached',
      serverId,
      expiredTime: result.expiredTime,
    });
  }
}

function toRkey(type: number, rkey: string, expiredTime: number): DownloadRkey {
  return {
    rkey,
    type,
    ttlSeconds: 0,
    createTime: expiredTime,
    // 服务器只给过期时刻、不给签发时间，直接用 expiredAt 表达绝对过期。
    expiredAt: expiredTime,
  };
}

function toRkeys(result: NapcatRkeyServerResult, wanted: number[]): DownloadRkey[] {
  const out: DownloadRkey[] = [];
  if (wanted.includes(10) && result.privateRkey) {
    out.push(toRkey(10, result.privateRkey, result.expiredTime));
  }
  if (wanted.includes(20) && result.groupRkey) {
    out.push(toRkey(20, result.groupRkey, result.expiredTime));
  }
  return out;
}
