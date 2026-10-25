/**
 * Misc database (misc.db).
 */

import { ProtoMsg } from '@weq/codec';
import { OnlineStatusBody, OnlineStatusCustomWire } from '@weq/codec/proto/profile/48902';
import { QqDb } from '../qq_db';

export class MiscDb extends QqDb {
  /**
   * Fetch online status for a specific user UID.
   */
  async getUserOnlineStatus(uid: string): Promise<OnlineStatusData | null> {
    if (!(await this.hasTable('online_status_kv_table'))) return null;
    const rows = await this.query('SELECT "48902" FROM online_status_kv_table WHERE "48901" = ?', [
      uid,
    ]);
    if (!rows || rows.length === 0 || !rows[0]) return null;

    const blob = rows[0][0] as Uint8Array;
    if (!blob) return null;

    const decoded = new ProtoMsg(OnlineStatusBody).decode(blob);
    const detail = decoded.status?.detail;
    if (!detail) return null;

    let customStatus: OnlineStatusData['customStatus'];
    if (detail.subType === 2000 && detail.extendedPayload) {
      const custom = new ProtoMsg(OnlineStatusCustomWire).decode(detail.extendedPayload);
      if (custom.faceId !== undefined && custom.text !== undefined && custom.faceType !== undefined)
        customStatus = { faceId: custom.faceId, text: custom.text, faceType: custom.faceType };
    }

    return {
      uin: detail.uin?.toString() ?? '',
      uid: detail.uid ?? '',
      type: detail.type ?? 0,
      subType: detail.subType ?? 0,
      statusName: detail.statusName ?? '',
      customStatus,
    };
  }
}

export interface OnlineStatusData {
  uin: string;
  uid: string;
  type: number;
  subType: number;
  statusName: string;
  customStatus?: { faceId: number; text: string; faceType: number };
}
