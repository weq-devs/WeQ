/** 同名配置在列表和模型选择中使用相同标识，不用密钥区分。 */
export function providerDisplayLabels(providers: readonly { id: string; name: string }[]) {
  return new Map(
    providers.map((provider) => {
      const sameName = providers.filter(
        (other) => other.id !== provider.id && other.name === provider.name,
      );
      const suffix = provider.id.slice(-8);
      const identifier = sameName.some((other) => other.id.endsWith(suffix)) ? provider.id : suffix;
      return [
        provider.id,
        sameName.length ? `${provider.name} · ${identifier}` : provider.name,
      ] as const;
    }),
  );
}
