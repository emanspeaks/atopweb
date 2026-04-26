//go:build !linux

package main

func runStreamer(binary string, baseArgs []string, h *hub) {}
func buildAtopArgs(updateIdx, instance int, pci string, apu, single, nopc bool) []string {
	return nil
}
func getAtopVersion(binary string) string {
	return "unknown"
}
