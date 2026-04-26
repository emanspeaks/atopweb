package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ── GPU process event detection ──────────────────────────────────────────────
//
// Three-layer early-detection pipeline, all without elevated privileges:
//
//  Layer 1 – KFD poll: /sys/class/kfd/kfd/proc appears per-PID when a process
//             opens /dev/kfd (ROCm/HIP init).  Fires ~200 ms after open vs the
//             full amdgpu_top fdinfo poll interval.
//
//  Layer 2 – known-proc poll: once a process name has been seen in fdinfo,
//             it enters the learning cache.  On subsequent runs the proc name
//             watcher fires as soon as that name appears in /proc — before the
//             process touches the GPU at all.
//
//  Layer 3 – fdinfo (existing client-side): still the authoritative source for
//             STOP events and for first-time processes unknown to the cache.
//
// procEventTracker deduplicates start events across all three layers by PID.

type procEvent struct {
	Type   string `json:"type"`  // always "proc_event"
	Event  string `json:"event"` // "start"
	PID    int    `json:"pid"`
	Name   string `json:"name"`
	TimeMs int64  `json:"time_ms"`
}

type procEventTracker struct {
	mu      sync.Mutex
	started map[int]bool
}

func newProcEventTracker() *procEventTracker {
	t := &procEventTracker{started: make(map[int]bool)}
	// Purge dead PIDs so that PID reuse doesn't suppress future events.
	go func() {
		tick := time.NewTicker(10 * time.Second)
		defer tick.Stop()
		for range tick.C {
			t.mu.Lock()
			for pid := range t.started {
				if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); os.IsNotExist(err) {
					delete(t.started, pid)
				}
			}
			t.mu.Unlock()
		}
	}()
	return t
}

// tryStart marks pid started and returns true the first time; false on dup.
func (t *procEventTracker) tryStart(pid int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.started[pid] {
		return false
	}
	t.started[pid] = true
	return true
}

func (t *procEventTracker) clear(pid int) {
	t.mu.Lock()
	delete(t.started, pid)
	t.mu.Unlock()
}

// gpuProcCache is a persistent set of process comm names known to use the GPU.
// Populated from amdgpu_top fdinfo; enables layer-2 early detection.
type gpuProcCache struct {
	mu    sync.RWMutex
	names map[string]bool
	path  string // JSON file path; "" = in-memory only
}

func loadGPUProcCache(path string) *gpuProcCache {
	c := &gpuProcCache{names: make(map[string]bool), path: path}
	if path == "" {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var names []string
	if err := json.Unmarshal(data, &names); err == nil {
		for _, n := range names {
			c.names[n] = true
		}
		log.Printf("gpu proc cache: loaded %d known names from %s", len(names), path)
	}
	return c
}

func (c *gpuProcCache) has(name string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.names[name]
}

// add returns true if name was newly added to the cache.
func (c *gpuProcCache) add(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.names[name] {
		return false
	}
	c.names[name] = true
	if c.path != "" {
		c.saveUnlocked()
	}
	return true
}

func (c *gpuProcCache) saveUnlocked() {
	names := make([]string, 0, len(c.names))
	for n := range c.names {
		names = append(names, n)
	}
	sort.Strings(names)
	data, _ := json.Marshal(names)
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, c.path)
}

// readProcName returns the comm string for pid by reading /proc/<pid>/comm,
// or "" if the process has already exited.
func readProcName(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (h *hub) broadcastProcEvent(ev procEvent) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.broadcast(data)
}

// watchKFDProcs polls /sys/class/kfd/kfd/proc for new ROCm/HIP process opens.
// Each subdirectory name is a PID; it appears when the process opens /dev/kfd.
// No privileges required.  Falls back silently if KFD is absent.
func watchKFDProcs(h *hub, tracker *procEventTracker) {
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
			name := readProcName(pid)
			if name == "" || !tracker.tryStart(pid) {
				continue
			}
			h.broadcastProcEvent(procEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("kfd watcher: start pid=%d name=%q", pid, name)
		}
		for pid := range known {
			if !current[pid] {
				delete(known, pid)
				tracker.clear(pid)
			}
		}
	}
}

// watchKnownGPUProcs polls /proc every 200 ms for new instances of process
// names that appear in the GPU proc cache.  This fires before the process
// touches the GPU — even before KFD is opened — for any program whose name
// has been seen in amdgpu_top fdinfo at least once before.
func watchKnownGPUProcs(h *hub, cache *gpuProcCache, tracker *procEventTracker) {
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
			name := readProcName(pid)
			if name == "" || !cache.has(name) {
				continue
			}
			known[pid] = true
			if !tracker.tryStart(pid) {
				continue
			}
			h.broadcastProcEvent(procEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("known-proc watcher: start pid=%d name=%q", pid, name)
		}
		for pid := range known {
			if !current[pid] {
				delete(known, pid)
				tracker.clear(pid)
			}
		}
	}
}

// minFdFrame is a minimal parse of the amdgpu_top JSON used only to extract
// process names for the GPU proc cache.
type minFdFrame struct {
	Devices []struct {
		Fdinfo map[string]struct {
			Name string `json:"name"`
		} `json:"fdinfo"`
		XdnaFdinfo map[string]struct {
			Name string `json:"name"`
		} `json:"xdna_fdinfo"`
	} `json:"devices"`
}

// populateGPUProcCache reads the last amdgpu_top frame every 2 s and adds any
// visible process names to the learning cache.
func populateGPUProcCache(h *hub, cache *gpuProcCache) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.Lock()
		raw := h.last
		h.mu.Unlock()
		if raw == nil {
			continue
		}
		var frame minFdFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		for _, dev := range frame.Devices {
			for _, p := range dev.Fdinfo {
				if p.Name != "" && cache.add(p.Name) {
					log.Printf("gpu proc cache: learned %q", p.Name)
				}
			}
			for _, p := range dev.XdnaFdinfo {
				if p.Name != "" && cache.add(p.Name) {
					log.Printf("gpu proc cache: learned %q", p.Name)
				}
			}
		}
	}
}
