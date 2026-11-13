import { z } from 'zod';
import { getAppContext } from '../context/app_context';

export const optionalAccountBinding = {
  expectedAccountUin: z.string().min(1).optional(),
  expectedAccountConfigId: z.string().min(1).optional(),
};

/** 兼容旧调用；新客户端的对象规则写入必须校验请求发起时的完整数据源身份。 */
export function assertAccountBinding(input: {
  expectedAccountUin?: string;
  expectedAccountConfigId?: string;
}): void {
  if (input.expectedAccountUin === undefined && input.expectedAccountConfigId === undefined) return;
  const record = getAppContext().services?.accountConfig.getRecord();
  if (
    !input.expectedAccountUin ||
    !input.expectedAccountConfigId ||
    record?.uin !== input.expectedAccountUin ||
    record?.configId !== input.expectedAccountConfigId
  )
    throw new Error('账号或数据源已切换，请返回原账号后重试');
}
