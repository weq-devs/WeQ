// 历史登录列表的摘要 —— quick / account-list 共用（同一 `login-list` 帧）。
//
// 只保留 quick-login 可用的账号，字段裁成前端需要的最小集。

import type { LoginListItem } from '../wrapper-types';

export interface LoginListSummary {
    uin: string;
    uid: string;
    nickName: string;
    faceUrl: string;
    facePath: string;
    loginType: number;
    isQuickLogin: boolean;
    isAutoLogin: boolean;
}

export function summarizeLoginList(items: LoginListItem[]): LoginListSummary[] {
    return items
        .filter((u) => u.isQuickLogin)
        .map((u) => ({
            uin: u.uin,
            uid: u.uid,
            nickName: u.nickName,
            faceUrl: u.faceUrl,
            facePath: u.facePath,
            loginType: u.loginType,
            isQuickLogin: u.isQuickLogin,
            isAutoLogin: u.isAutoLogin,
        }));
}
