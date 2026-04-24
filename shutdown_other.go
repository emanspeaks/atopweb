//go:build !linux

package main

func watchShutdownFile(h *hub) {}

func pushShutdownAlert(h *hub, msg string) {}
