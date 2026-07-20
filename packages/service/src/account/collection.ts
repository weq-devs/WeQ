/**
 * CollectionService — read QQ favorites (收藏).
 *
 * 网络优先、数据库回退:能拿到 weiyun.com 的 p_skey 就走微云 collector 网关
 * (最新数据、不依赖本地 collection.db);拿不到凭据(未注入 / 静态账号 / 关了
 * ClientKey)才回退到本地 collection.db。网络请求本身报错直接抛(不静默),便于排查。
 */

import type { AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import type { CollectionItem } from '@weq/db';
import { getLogger, logErrorContext } from '../common/logger';
import { WebCredentialProvider } from './web/credential';
import { getCollectionListNetwork } from './web/collection';

const WEIYUN_DOMAIN = 'weiyun.com';

export interface CollectionPage {
  /** Items on this page, newest-collected first. */
  items: CollectionItem[];
  /** Offset this page started at. */
  offset: number;
  /** Requested page size. */
  limit: number;
  /** Whether more items exist past this page. */
  hasMore: boolean;
  /** Where the items came from — useful for the UI / debugging. */
  source: 'network' | 'db';
}

export class CollectionService {
  private readonly creds: WebCredentialProvider;
  private readonly logger;

  constructor(
    nt: Pick<NtHelperBinding, 'fetchSkey' | 'fetchPskey' | 'fetchClientKey'>,
    private readonly session: AccountSession,
    resolvePid: () => number,
  ) {
    this.creds = new WebCredentialProvider(nt, session.context.uin, resolvePid);
    this.logger = getLogger().child({ scope: 'collection', accountUin: session.context.uin });
  }

  /**
   * List collected items with pagination. Tries the collector network path
   * first (pulls up to offset+limit+1 items so `hasMore` is exact); falls back
   * to local collection.db only when a p_skey can't be obtained.
   */
  async listCollections(limit = 50, offset = 0): Promise<CollectionPage> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const safeOffset = Math.max(0, offset);

    const network = await this.tryNetwork(safeLimit, safeOffset);
    if (network) return network;

    return this.fromDb(safeLimit, safeOffset);
  }

  /** Total number of collected items (db-backed count). */
  async countCollections(): Promise<number> {
    return this.session.collection.count();
  }

  /**
   * 网络路径:拿 weiyun.com p_skey → collector.fcg 拉取。拿不到 p_skey 返回 null
   * (让调用方回退 db);网络请求本身失败则抛出。
   */
  private async tryNetwork(limit: number, offset: number): Promise<CollectionPage | null> {
    let cred;
    try {
      cred = await this.creds.forDomain(WEIYUN_DOMAIN);
    } catch (error) {
      // 拿不到凭据(未注入 / 静态账号 noPid / 关了 ClientKey)→ 回退 db。
      this.logger.info('no weiyun p_skey — falling back to collection.db', {
        event: 'collection-network-no-cred',
        ...logErrorContext(error),
      });
      return null;
    }
    if (!cred.pskey) {
      this.logger.info('empty weiyun p_skey — falling back to collection.db', {
        event: 'collection-network-empty-pskey',
      });
      return null;
    }

    // 有凭据:网络拉取,报错直接抛(不静默吞成 db 回退)。
    const wanted = offset + limit + 1;
    const page = await getCollectionListNetwork(cred, wanted);
    const window = page.items.slice(offset, offset + limit);
    const hasMore = page.hasMore || page.items.length > offset + limit;
    return { items: window, offset, limit, hasMore, source: 'network' };
  }

  /** Local collection.db path — fetches one extra row to compute `hasMore`. */
  private async fromDb(limit: number, offset: number): Promise<CollectionPage> {
    const rows = await this.session.collection.listAll(limit + 1, offset);
    const hasMore = rows.length > limit;
    return {
      items: hasMore ? rows.slice(0, limit) : rows,
      offset,
      limit,
      hasMore,
      source: 'db',
    };
  }
}
