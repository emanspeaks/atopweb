//go:build !linux

package main

import "log"

func watchFanotifyGPU(*hub, *procEventTracker, []string) {
	log.Printf("fanotify watcher: not supported on this platform; skipping")
}
