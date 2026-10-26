import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';

/** 旧工具可省略身份；融合工具始终传完整账号和配置来源。 */
export const resourceSourceInput = z.object({
  expectedAccountUin: z.string().min(1).optional(),
  expectedAccountConfigId: z.string().min(1).optional(),
});

export function requireResourceSource(
  input?: z.infer<typeof resourceSourceInput>,
): AccountServices {
  const context = getAppContext();
  if (
    input?.expectedAccountUin &&
    String(context.account?.context.uin ?? '') !== input.expectedAccountUin
  )
    throw new Error('账号已切换，已停止资源操作');
  if (
    input?.expectedAccountConfigId &&
    context.services?.accountConfig.getRecord()?.configId !== input.expectedAccountConfigId
  )
    throw new Error('账号数据源已切换，已停止资源操作');
  if (!context.services) throw new Error('当前未打开账号');
  return context.services;
}

export function assertResourceSource(
  services: AccountServices,
  input?: z.infer<typeof resourceSourceInput>,
): void {
  if (requireResourceSource(input) !== services)
    throw new Error('账号实例已切换，已丢弃旧资源结果');
}
