// Cross-compile stubs for libdrm and libdrm_amdgpu.
// These satisfy the linker when cross-compiling on Windows; the real
// implementations are used at runtime on Linux via the system libdrm.
#include <stdint.h>

typedef void *amdgpu_device_handle;
typedef struct {
	int   version_major, version_minor, version_patchlevel;
	int   name_len; char *name;
	int   date_len; char *date;
	int   desc_len; char *desc;
} drmVersion;

int  amdgpu_device_initialize(int fd, uint32_t *maj, uint32_t *min, amdgpu_device_handle *dev) { (void)fd; (void)maj; (void)min; (void)dev; return -1; }
void amdgpu_device_deinitialize(amdgpu_device_handle dev)                                       { (void)dev; }
int  amdgpu_read_mm_registers(amdgpu_device_handle dev, unsigned off, unsigned cnt, uint32_t inst, uint32_t flags, uint32_t *vals) { (void)dev; (void)off; (void)cnt; (void)inst; (void)flags; (void)vals; return -1; }
int  drmCommandWriteRead(int fd, unsigned long cmd, void *data, unsigned long size)              { (void)fd; (void)cmd; (void)data; (void)size; return -1; }
drmVersion *drmGetVersion(int fd)                                                                { (void)fd; return 0; }
void drmFreeVersion(drmVersion *v)                                                               { (void)v; }
