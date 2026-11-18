/**
 * Shared presentational controls for the 设置 panels.
 *
 * 颜色跟随主题语义 token；控件沿用设置页的密度、细描边和小圆角。
 * 开关使用独立 weq-set-* 类名，不与关系图等业务组件耦合。
 */

import { createContext } from 'react';
import type { SettingsScope } from './navigation';
import '../../styles/settings-query.css';
import '../../styles/settings-controls.css';

export const SettingsScopeContext = createContext<SettingsScope | null>(null);

/**
 * 卡片 head 右侧的状态位。`AutoSave` 有槽位时把校验和保存错误
 * 放进卡片标题行，避免它挤在行描述的位置上被当成人话说明。
 */
export const SaveStatusSlotContext = createContext<{ take: () => HTMLElement | null } | null>(null);

/**
 * 在设置页之间跳转。由 `SettingsDialog` 提供，页面里的「去管理」这类入口消费。
 * 不提供时（例如单测直接渲染某个 section）为 `null`，调用方应自行降级。
 */
export const SettingsNavigateContext = createContext<
  ((section: string, settingId?: string) => void) | null
>(null);
