import { vi } from 'vitest';

// 业务界面用例固定为普通模式；开发工具开关由其专属用例覆盖。
vi.mock('../../src/renderer/src/hooks/useDevelopmentDressTools', () => ({
  useDevelopmentDressTools: () => false,
}));
