/* 仅模拟私有 IPC，不加载 QQ、不联网、不打开业务数据库。 */
let options;
function emit(event, instanceId = options.instanceId, pid = process.pid, done) {
  process.send?.({ ...event, instanceId, pid }, done);
}
process.on('message', (message) => {
  if (message.type === 'boot') {
    options = message.options;
    emit({ type: 'initialized', exportCount: 4 }, 'stale-instance');
    emit({ type: 'initialized', exportCount: 4 }, options.instanceId, process.pid + 100);
    if (options.device.hostName === 'fail-boot') {
      emit(
        { type: 'error', code: 'worker-command', message: 'fixture unsupported', retryable: false },
        options.instanceId,
        process.pid,
        () => process.exit(1),
      );
      return;
    }
    emit({ type: 'initialized', exportCount: 4 });
    return;
  }
  if (!options || message.instanceId !== options.instanceId || message.nonce !== options.nonce)
    return;
  if (message.type === 'login') {
    emit({ type: 'qr', pngBase64: 'fixture-image', url: 'https://qq.com/fixture' });
    emit({ type: 'login', uin: options.expectedUin, uid: 'u_fixture' });
    emit({
      type: 'session-initialized',
      uin: options.expectedUin,
      uid: 'u_fixture',
      guid: '11'.repeat(16),
      dataRoot: options.dataRoot,
      capabilities: { sso: true, database: true },
      dbKey: 'not-forwarded',
    });
  }
  if (message.type === 'health') emit({ type: 'health', connected: true, loggedIn: true });
  if (message.type === 'stop') {
    emit({ type: 'stopped' });
    process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0));
