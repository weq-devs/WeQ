/**
 * OnlineStatusService — fetch and format user online status.
 */

import type { AccountSession } from '@weq/account';

export enum OnlineType {
  ONLINE = 10,
  Q_ME = 60,
  AWAY = 30,
  BUSY = 50,
  DND = 70, // Do Not Disturb
  INVISIBLE = 40,
  OFFLINE = 0,
}

export const ONLINE_TYPE_NAMES: Record<number, string> = {
  [OnlineType.ONLINE]: '在线',
  [OnlineType.Q_ME]: 'Q我吧',
  [OnlineType.AWAY]: '离开',
  [OnlineType.BUSY]: '忙碌',
  [OnlineType.DND]: '勿扰',
  [OnlineType.INVISIBLE]: '隐身',
  [OnlineType.OFFLINE]: '离线',
};

export const SUB_TYPE_NAMES: Record<number, string> = {
  1028: '听歌中',
  2037: '春日限定',
  2025: '圆梦',
  2026: '求星搭子',
  2014: '被掏空',
  1030: '今日天气',
  2019: '我crash了',
  2006: '爱你',
  1051: '恋爱中',
  1071: '好运锦鲤',
  1201: '水逆退散',
  1056: '嗨到飞起',
  1058: '元气满满',
  1070: '宝宝认证',
  1063: '一言难尽',
  2001: '难得糊涂',
  1401: 'emo中',
  1062: '我太难了',
  2013: '我想开了',
  1052: '我没事',
  1061: '想静静',
  1059: '悠哉哉',
  1011: '信号弱',
  2015: '去旅行',
  2003: '出去浪',
  2012: '肝作业',
  1018: '学习中',
  2023: '搬砖中',
  1300: '摸鱼中',
  1060: '无聊中',
  1027: 'timi中',
  1016: '睡觉中',
  1032: '熬夜中',
  1021: '追剧中',
};

export interface FormattedOnlineStatus {
  uid: string;
  uin: string;
  type: number;
  typeName: string;
  subType: number;
  subTypeName: string;
  displayStatus: string; // The combination for UI
  weather?: {
    weather: string;
    city: string;
    area: string;
    weatherDesc: string;
  };
}

export class OnlineStatusService {
  constructor(private readonly session: AccountSession) {}

  /**
   * Get formatted online status for a user.
   */
  async getOnlineStatus(uid: string): Promise<FormattedOnlineStatus | null> {
    // We need to ensure MiscDb is available in AccountSession. 
    // Assuming we'll add it there.
    const raw = await (this.session as any).misc?.getUserOnlineStatus(uid);
    if (!raw) return null;

    const typeName = ONLINE_TYPE_NAMES[raw.type] || '未知';
    let subTypeName = '';
    
    // As per requirement, only parse subtype for type 10 (ONLINE)
    if (raw.type === OnlineType.ONLINE) {
      subTypeName = SUB_TYPE_NAMES[raw.subType] || '';
    }

    let displayStatus = raw.statusName || typeName;
    if (subTypeName) {
      displayStatus = `${typeName} - ${subTypeName}`;
    }

    return {
      uid: raw.uid,
      uin: raw.uin,
      type: raw.type,
      typeName,
      subType: raw.subType,
      subTypeName,
      displayStatus,
      weather: raw.weather,
    };
  }
}
