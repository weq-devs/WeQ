/** 开发模块图按需发现，没有固定总大小；通过旧手机壳已有阶段协议报告实际加载量。 */
export const developmentStartupProgress = String.raw`
(function () {
  if (window.__weqDevelopmentProgress) return;
  window.__weqDevelopmentProgress = true;
  var seen = new Set(), bytes = 0, count = 0, timer, observer, closed = false, last = '';
  function code(value) {
    try {
      var url = new URL(value, location.href);
      return url.origin === location.origin &&
        (/\.(?:[cm]?js|jsx|tsx?|css)$/.test(url.pathname) ||
          url.pathname === '/@vite/client' || url.pathname === '/@react-refresh');
    } catch (_) { return false; }
  }
  function collect(entries) {
    if (closed) return;
    entries.forEach(function (entry) {
      if (seen.has(entry) || !code(entry.name) || entry.responseStatus >= 400 || entry.responseStatus === 0) return;
      var size = entry.decodedBodySize || entry.encodedBodySize;
      if (!Number.isSafeInteger(size) || size <= 0) return;
      seen.add(entry);
      bytes += size;
      count++;
    });
  }
  function report() {
    timer = undefined;
    if (closed) return;
    var state = window.weqRemoteStartup;
    if (state && (state.state !== 'loading' ||
        (state.message && state.message !== last && state.message !== '正在加载界面模块'))) return;
    var amount = bytes >= 1000000 ? (bytes / 1000000).toFixed(1) + ' MB' : (bytes / 1000).toFixed(1) + ' KB';
    var message = count ? '正在加载网页资源（已加载 ' + amount + '，' + count + ' 项）' : '正在加载网页资源';
    if (state && state.message === message) return;
    last = message;
    window.weqRemoteStartup = { state: 'loading', message: message };
    window.dispatchEvent(new Event('weq-remote-startup'));
  }
  function schedule() { if (!closed && timer === undefined) timer = setTimeout(report, 100); }
  function scan() { collect(performance.getEntriesByType('resource')); schedule(); }
  function stop() {
    closed = true;
    clearTimeout(timer);
    if (observer) observer.disconnect();
    seen.clear();
    document.removeEventListener('readystatechange', scan);
    window.removeEventListener('load', scan, true);
    window.removeEventListener('weq-remote-startup', startup);
    window.removeEventListener('pagehide', stop);
  }
  function startup() {
    var state = window.weqRemoteStartup;
    if (state && state.state !== 'loading') stop();
    else if (state && state.message === '正在加载界面模块') schedule();
  }
  if (typeof PerformanceObserver !== 'undefined') {
    observer = new PerformanceObserver(function (list) { collect(list.getEntries()); schedule(); });
    try { observer.observe({ type: 'resource', buffered: true }); }
    catch (_) { observer.observe({ entryTypes: ['resource'] }); }
  }
  document.addEventListener('readystatechange', scan);
  window.addEventListener('load', scan, true);
  window.addEventListener('weq-remote-startup', startup);
  window.addEventListener('pagehide', stop);
  collect(performance.getEntriesByType('resource'));
  report();
})();`;
