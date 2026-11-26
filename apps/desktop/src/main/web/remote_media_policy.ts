export const remoteMediaDirectives = ['img-src', 'media-src'] as const;

/** HTML 与网关的 CSP 同时生效，只给 Remote 页面补充 HTTPS 媒体来源。 */
export function allowRemoteMedia(directives: string[][]): void {
  const defaults = directives.find(([name]) => name === 'default-src');
  for (const name of remoteMediaDirectives) {
    const sources = directives.find(([directive]) => directive === name);
    if (sources) {
      if (sources[1] === "'none'" && sources.length === 2) sources.pop();
      if (!sources.includes('https:')) sources.push('https:');
    } else if (defaults) {
      directives.push([name, ...defaults.slice(1).filter((value) => value !== "'none'"), 'https:']);
    }
  }
}
