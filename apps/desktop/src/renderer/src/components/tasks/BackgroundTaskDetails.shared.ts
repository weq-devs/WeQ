import {
  CalendarDays,
  BarChart3,
  ArchiveRestore,
  Database,
  Download,
  Forward,
  HardDrive,
  RotateCw,
  SmilePlus,
  Upload,
  Users,
} from 'lucide-react';
import '../../styles/export.css';
import '../../styles/conversation-overview-calendar.css';
import '../../styles/contact-directory-order.css';
import '../../styles/long-tasks.css';

export const BACKGROUND_TASK_LABELS = {
  analysis: '分析报告',
  calendar: '会话日历',
  contacts: '好友/群信息缓存',
  model: '模型下载',
  update: '软件更新',
  database: '数据库维护',
  backup: '备份与恢复',
  'favorite-import': '收藏表情导入',
  forward: '逐条转发',
  'album-upload': '群相册上传',
  resource: '资源管理',
};

export const BACKGROUND_TASK_ICONS = {
  analysis: BarChart3,
  calendar: CalendarDays,
  contacts: Users,
  model: Download,
  update: RotateCw,
  database: Database,
  backup: ArchiveRestore,
  'favorite-import': SmilePlus,
  forward: Forward,
  'album-upload': Upload,
  resource: HardDrive,
};
