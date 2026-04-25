package main

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"
)

func WatchKFDProcs(h *Hub, tracker *ProcEventTracker) {
	const kfdDir = "/sys/class/kfd/kfd/proc"
	if _, err := os.Stat(kfdDir); err != nil {
		log.Printf("kfd watcher: %s unavailable — ROCm start events will use fdinfo lag", kfdDir)
		return
	}
	log.Printf("kfd watcher: monitoring %s (200 ms poll)", kfdDir)

	known := make(map[int]bool)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		entries, err := os.ReadDir(kfdDir)
		if err != nil {
			continue
		}
		current := make(map[int]bool, len(entries))
		for _, e := range entries {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			current[pid] = true
			if known[pid] {
				continue
			}
			known[pid] = true
			name := ReadProcName(pid)
			if name == "" || !tracker.TryStart(pid) {
				continue
			}
			h.BroadcastProcEvent(ProcEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("kfd watcher: start pid=%d name=%q", pid, name)
		}
		for pid := range known {
			if !current[pid] {
				delete(known, pid)
				tracker.Clear(pid)
			}
		}
	}
}

func WatchKnownGPUProcs(h *Hub, cache *GPUProcCache, tracker *ProcEventTracker) {
	log.Printf("known-proc watcher: active (200 ms poll of /proc)")
	known := make(map[int]bool)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		entries, err := os.ReadDir("/proc")
		if err != nil {
			continue
		}
		current := make(map[int]bool, len(entries))
		for _, e := range entries {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			current[pid] = true
			if known[pid] {
				continue
			}
			name := ReadProcName(pid)
			if name == "" || !cache.Has(name) {
				continue
			}
			known[pid] = true
			if !tracker.TryStart(pid) {
				continue
			}
			h.BroadcastProcEvent(ProcEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("known-proc watcher: start pid=%d name=%q", pid, name)
		}
		for pid := range known {
			if !current[pid] {
				delete(known, pid)
				tracker.Clear(pid)
			}
		}
	}
}
