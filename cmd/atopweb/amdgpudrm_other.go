//go:build !(linux && cgo)

package main

const drmAvailable = false

func runDRMPoller(h *hub, noPC bool) {}
