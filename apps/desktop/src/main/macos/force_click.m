#import <AppKit/AppKit.h>
#include <node_api.h>

@interface WeQForceClick : NSObject
@property(nonatomic, weak) NSView *view;
@property(nonatomic, strong) id monitor;
@property(nonatomic, strong) NSEvent *pressure;
@property(nonatomic, strong) NSEvent *mouseUp;
@property(nonatomic) BOOL pressed;
@property(nonatomic) BOOL replaying;
@property(nonatomic) BOOL consumed;
@property(nonatomic) uint32_t sequence;
@property(nonatomic) napi_env env;
@property(nonatomic) napi_ref callback;
@end

@implementation WeQForceClick
- (void)finish:(BOOL)handled {
  NSEvent *pressure = self.pressure;
  NSEvent *release = self.mouseUp;
  self.pressure = nil;
  self.mouseUp = nil;
  self.consumed = handled;
  self.replaying = YES;
  if (!handled && pressure.window) [NSApp sendEvent:pressure];
  if (release.window) [NSApp sendEvent:release];
  self.replaying = NO;
}

- (void)stop {
  if (self.monitor) [NSEvent removeMonitor:self.monitor];
  self.monitor = nil;
  self.pressure = nil;
  self.mouseUp = nil;
  if (self.callback) napi_delete_reference(self.env, self.callback);
  self.callback = NULL;
}

- (BOOL)notify:(NSPoint)point {
  napi_handle_scope scope;
  if (napi_open_handle_scope(self.env, &scope) != napi_ok) return NO;
  napi_value callback, receiver, args[3], result;
  napi_status status = napi_get_reference_value(self.env, self.callback, &callback);
  if (status == napi_ok) status = napi_get_undefined(self.env, &receiver);
  if (status == napi_ok) status = napi_create_double(self.env, point.x, &args[0]);
  if (status == napi_ok) status = napi_create_double(self.env, point.y, &args[1]);
  if (status == napi_ok) status = napi_create_uint32(self.env, self.sequence, &args[2]);
  if (status == napi_ok) status = napi_call_function(self.env, receiver, callback, 3, args, &result);
  if (status == napi_pending_exception) napi_get_and_clear_last_exception(self.env, &result);
  napi_close_handle_scope(self.env, scope);
  return status == napi_ok;
}

- (NSEvent *)handle:(NSEvent *)event {
  NSView *view = self.view;
  if (self.replaying || !view.window || event.window != view.window) return event;
  switch (event.type) {
    case NSEventTypeLeftMouseDown: {
      if (self.pressure) [self finish:NO];
      self.consumed = NO;
      NSEventModifierFlags modifiers = NSEventModifierFlagShift | NSEventModifierFlagControl |
          NSEventModifierFlagOption | NSEventModifierFlagCommand;
      self.pressed = (event.modifierFlags & modifiers) == 0;
      return event;
    }
    case NSEventTypeLeftMouseDragged:
      self.pressed = NO;
      return event;
    case NSEventTypeLeftMouseUp:
      self.pressed = NO;
      if (!self.pressure) return event;
      // 先让页面认领重按，再交还松手事件。页面可据此只取消同一次手势的普通 click。
      self.mouseUp = event;
      return nil;
    case NSEventTypePressure: {
      if (event.stage == 2 && (self.pressure || self.consumed)) return nil;
      if (!self.pressed || event.stage != 2) return event;
      self.pressed = NO;
      NSPoint point = [view convertPoint:event.locationInWindow fromView:nil];
      if (!NSPointInRect(point, view.bounds)) return event;
      if (!view.flipped) point.y = NSHeight(view.bounds) - point.y;
      self.pressure = event;
      self.sequence++;
      if ([self notify:point]) return nil;
      self.pressure = nil;
      return event;
    }
    default:
      return event;
  }
}
@end

static void finalize(__unused napi_env env, void *data, __unused void *hint) {
  WeQForceClick *listener = (__bridge_transfer WeQForceClick *)data;
  [listener stop];
}

static napi_value finish(napi_env env, napi_callback_info info) {
  napi_value self, args[2];
  size_t argc = 2;
  void *data = NULL;
  uint32_t sequence;
  bool handled = false;
  napi_get_cb_info(env, info, &argc, args, &self, NULL);
  if (argc == 2 && napi_unwrap(env, self, &data) == napi_ok &&
      napi_get_value_uint32(env, args[0], &sequence) == napi_ok &&
      napi_get_value_bool(env, args[1], &handled) == napi_ok) {
    WeQForceClick *listener = (__bridge WeQForceClick *)data;
    if (sequence == listener.sequence && listener.pressure) [listener finish:handled];
  }
  return NULL;
}

static napi_value stop(napi_env env, napi_callback_info info) {
  napi_value self;
  size_t argc = 0;
  void *data = NULL;
  napi_get_cb_info(env, info, &argc, NULL, &self, NULL);
  if (napi_unwrap(env, self, &data) == napi_ok) [(__bridge WeQForceClick *)data stop];
  return NULL;
}

static napi_value observe(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  void *buffer = NULL;
  size_t argc = 2, length = 0;
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  if (argc != 2 || napi_get_buffer_info(env, args[0], &buffer, &length) != napi_ok ||
      length != sizeof(NSView *)) {
    napi_throw_type_error(env, NULL, "Expected a BrowserWindow native handle and callback");
    return NULL;
  }
  void *pointer;
  memcpy(&pointer, buffer, sizeof(pointer));
  WeQForceClick *listener = [WeQForceClick new];
  listener.view = (__bridge NSView *)pointer;
  listener.env = env;
  napi_ref callback;
  if (napi_create_reference(env, args[1], 1, &callback) != napi_ok) return NULL;
  listener.callback = callback;
  __weak WeQForceClick *weakListener = listener;
  listener.monitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskPressure | NSEventMaskLeftMouseDown |
                                            NSEventMaskLeftMouseUp | NSEventMaskLeftMouseDragged
      handler:^NSEvent *(NSEvent *event) {
        WeQForceClick *current = weakListener;
        return current ? [current handle:event] : event;
      }];
  napi_create_object(env, &result);
  napi_wrap(env, result, (__bridge_retained void *)listener, finalize, NULL, NULL);
  napi_property_descriptor methods[] = {
      {.utf8name = "finish", .method = finish},
      {.utf8name = "stop", .method = stop},
  };
  napi_define_properties(env, result, 2, methods);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "observe", NAPI_AUTO_LENGTH, observe, NULL, &function);
  napi_set_named_property(env, exports, "observe", function);
  return exports;
}
