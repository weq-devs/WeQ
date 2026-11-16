import { BackgroundTaskRegistry } from '../../../shared/background_task';

/** 逐条转发、浏览器分片上传等显式后台操作的生命周期由当前窗口负责。 */
export const localBackgroundTasks = new BackgroundTaskRegistry();
