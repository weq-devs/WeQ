/**
 * CollectionService — read QQ favorites (收藏) from collection.db.
 */

import type { AccountSession } from '@weq/account';
import type { CollectionItem } from '@weq/db';

export interface CollectionPage {
  /** Items on this page, newest-collected first. */
  items: CollectionItem[];
  /** Offset this page started at. */
  offset: number;
  /** Requested page size. */
  limit: number;
  /** Whether more items exist past this page. */
  hasMore: boolean;
}

export class CollectionService {
  constructor(private readonly session: AccountSession) {}

  /**
   * List collected items with pagination. Fetches one extra row to compute
   * `hasMore` without a separate COUNT round-trip.
   */
  async listCollections(limit = 50, offset = 0): Promise<CollectionPage> {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const safeOffset = Math.max(0, offset);
    const rows = await this.session.collection.listAll(safeLimit + 1, safeOffset);
    const hasMore = rows.length > safeLimit;
    return {
      items: hasMore ? rows.slice(0, safeLimit) : rows,
      offset: safeOffset,
      limit: safeLimit,
      hasMore,
    };
  }

  /** Total number of collected items. */
  async countCollections(): Promise<number> {
    return this.session.collection.count();
  }
}
