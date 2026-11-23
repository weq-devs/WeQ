/** 打包页用原生百分比桥；逐模块模式及旧手机壳仍可显示已完成项数。 */
export const developmentStartupProgress = String.raw`
(function () {
  if (window.__weqDevelopmentProgress) return;
  window.__weqDevelopmentProgress = true;
  var handlers = window.webkit && window.webkit.messageHandlers;
  var links = window.weqRemoteLinks;
  var measured = document.querySelector('meta[name="weq-startup-resources"]');
  var phase = measured ? '正在加载开发版首批资源' : '正在加载网页资源';
  if (measured && (typeof handlers?.weqResources?.postMessage === 'function' ||
      typeof links?.resources === 'function')) {
    window.weqRemoteStartup = { state: 'loading', message: phase };
    window.dispatchEvent(new Event('weq-remote-startup'));
    return;
  }
  var seen = new Set(), bytes = 0, cached = 0, unknown = 0, count = 0;
  var timer, observer, closed = false, last = '';
  var direct = !!handlers?.weqResources;
  var nativeProgress = handlers?.weqDevelopmentResources;
  var androidProgress = typeof links?.developmentResources === 'function';
  var lastCount = -1;
  function code(value) {
    try {
      var url = new URL(value, location.href);
      return url.origin === location.origin &&
        (/\.(?:[cm]?js|jsx|tsx?|css)$/.test(url.pathname) ||
          url.pathname === '/@vite/client' || url.pathname === '/@vite/lazy' ||
          url.pathname === '/@react-refresh');
    } catch (_) { return false; }
  }
  function collect(entries) {
    if (closed) return;
    entries.forEach(function (entry) {
      var key = JSON.stringify([entry.name, entry.startTime, entry.responseEnd]);
      if (seen.has(key) || !code(entry.name) || entry.responseStatus >= 400) return;
      var size = entry.decodedBodySize || entry.encodedBodySize;
      if ((!Number.isSafeInteger(size) || size <= 0) &&
          entry.responseStatus !== 304 && entry.deliveryType !== 'cache') return;
      seen.add(key);
      var transport = '';
      if (Array.isArray(entry.serverTiming)) entry.serverTiming.forEach(function (metric) {
        if (metric.name === 'weq-remote-source') transport = metric.description;
      });
      if (entry.workerStart > 0) unknown++;
      else if (entry.deliveryType === 'cache' || entry.responseStatus === 304 ||
          (entry.transferSize === 0 && entry.encodedBodySize > 0 && entry.responseStatus >= 200) ||
          (entry.transferSize === 300 && entry.encodedBodySize > 0) ||
          transport === 'cache') cached++;
      else if ((direct || transport === 'network') && entry.transferSize > 0 &&
          Number.isSafeInteger(entry.encodedBodySize) && entry.encodedBodySize > 0) bytes += entry.encodedBodySize;
      else unknown++;
      count++;
    });
  }
  function report() {
    timer = undefined;
    if (closed) return;
    var state = window.weqRemoteStartup;
    if (state && state.state !== 'loading') return;
    if (nativeProgress || androidProgress) {
      if (count === lastCount) return;
      lastCount = count;
      var progress = { completed: count, downloadedBytes: bytes, cached: cached, unknown: unknown };
      window.weqRemoteDevelopmentResources = progress;
      if (nativeProgress) nativeProgress.postMessage(progress);
      else window.weqRemoteLinks.developmentResources(JSON.stringify(progress));
      return;
    }
    if (state && state.message && state.message !== last) phase = state.message;
    var amount = bytes >= 1000000 ? (bytes / 1000000).toFixed(1) + ' MB' : (bytes / 1000).toFixed(1) + ' KB';
    var details = ['完成 ' + count + ' 项'];
    if (bytes > 0) details.push('已下载 ' + amount);
    if (cached) details.push('缓存 ' + cached + ' 项');
    if (unknown) details.push(unknown + ' 项下载量待确认');
    var message = count ? phase + '（' + details.join('，') + '）' : phase;
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
    else if (!nativeProgress && !androidProgress && state && state.message !== last) schedule();
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
