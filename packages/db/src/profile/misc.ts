/**
 * Misc database (misc.db).
 */

import { ProtoMsg } from '@weq/codec';
import { OnlineStatusBody } from '@weq/codec/proto/profile/48902';
import { QqDb } from '../qq_db';

export class MiscDb extends QqDb {
  /**
   * Fetch online status for a specific user UID.
   */
  async getUserOnlineStatus(uid: string): Promise<OnlineStatusData | null> {
    const rows = await this.query(
      'SELECT "48902" FROM online_status_kv_table WHERE "48901" = ?',
      [uid]
    );
    if (!rows || rows.length === 0 || !rows[0]) return null;

    const blob = rows[0][0] as Uint8Array;
    if (!blob) return null;

    const decoded = new ProtoMsg(OnlineStatusBody).decode(blob);
    const detail = decoded.status?.detail;
    if (!detail) return null;

    return {
      uin: detail.uin?.toString() ?? '',
      uid: detail.uid ?? '',
      type: detail.type ?? 0,
      subType: detail.subType ?? 0,
      statusName: detail.statusName ?? '',
      weather: detail.weather ? {
        weather: detail.weather.weather ?? '',
        city: detail.weather.city ?? '',
        area: detail.weather.area ?? '',
        weatherDesc: detail.weather.weatherDesc ?? '',
      } : undefined,
    };
  }
}

export interface OnlineStatusData {
  uin: string;
  uid: string;
  type: number;
  subType: number;
  statusName: string;
  weather?: {
    weather: string;
    city: string;
    area: string;
    weatherDesc: string;
  };
}
