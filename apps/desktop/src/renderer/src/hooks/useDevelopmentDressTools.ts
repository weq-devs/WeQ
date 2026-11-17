import { trpc } from '../trpc/client';

/** 由宿主判断开发环境和启动参数，网页或 Remote 不自行开启。 */
export function useDevelopmentDressTools(): boolean {
  const features = trpc.bootstrap.getDevelopmentFeatures.useQuery(undefined, {
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  return features.data?.dressTools === true;
}
