#include <stdint.h>

/* 仅转发官方 QQ 模块的宿主注册，不实现登录、签名或传输。 */
extern void napi_module_register(void *module);

__attribute__((visibility("default")))
void qq_magic_napi_register(void *module) {
  napi_module_register(module);
}

__attribute__((visibility("default")))
void *napi_register_module_v1(void *env, void *exports) {
  (void)env;
  return exports;
}

__attribute__((visibility("default")))
int32_t node_api_module_get_api_version_v1(void) {
  return 8;
}
