export const PROFILE_QUERY_OPTIONS = {
  staleTime: 5 * 60_000,
  cacheTime: 5 * 60_000,
  retry: false as const,
  refetchOnWindowFocus: false,
};
