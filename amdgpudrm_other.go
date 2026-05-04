//go:build !linux

package main

const drmAvailable = false

func runDRMPoller(h *hub, noPC bool) {}
