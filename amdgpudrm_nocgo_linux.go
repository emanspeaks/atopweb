//go:build linux && !cgo

package main

// drmAvailable is false when the binary is built without CGO. The DRM backend
// requires CGO to call into libdrm; without it main falls back to amdgpu_top.
const drmAvailable = false

func runDRMPoller(h *hub, noPC bool) {}
