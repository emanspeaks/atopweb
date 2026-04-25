//go:build !linux

package main

func watchShutdownFile(h *hub)    {}
func watchLogindShutdown(h *hub) {}
