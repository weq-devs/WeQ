import { BackgroundTaskRegistry } from '../../../shared/background_task';

/** 逐条转发、浏览器分片上传与页面扫描的生命周期由当前窗口负责。 */
export const localBackgroundTasks = new BackgroundTaskRegistry();
