package main

import (
	"encoding/json"
	"time"
)

// runSystemPusher pushes a system-info frame to all SSE clients once per
// second.  Uses pushEvent("system") so h.last always holds the last GPU frame.
func runSystemPusher(h *hub) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var prevCPU cpuStat
	hasPrevCPU := false
	for range ticker.C {
		info := buildSystemInfo()
		curr, ok := readCPUStat()
		if ok {
			if hasPrevCPU && curr.total() > prevCPU.total() {
				dt := curr.total() - prevCPU.total()
				idleDelta := (curr.idle + curr.iowait) - (prevCPU.idle + prevCPU.iowait)
				if idleDelta <= dt {
					pct := float64(dt-idleDelta) / float64(dt) * 100
					info.CPUUsagePct = &pct
				}
			}
			prevCPU = curr
			hasPrevCPU = true
		}
		b, err := json.Marshal(info)
		if err != nil {
			continue
		}
		h.pushEvent("system", b)
	}
}

// runMemPusher pushes a fast-refresh memory snapshot to all SSE clients at the
// same cadence as the GPU sampler (h.intervalMs), auto-adjusting on interval
// changes.  Uses pushEvent("mem") so h.last always holds the last GPU frame.
func runMemPusher(h *hub) {
	h.mu.Lock()
	cur := h.intervalMs
	h.mu.Unlock()
	ticker := time.NewTicker(time.Duration(cur) * time.Millisecond)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.Lock()
		next := h.intervalMs
		h.mu.Unlock()
		if next != cur {
			cur = next
			ticker.Reset(time.Duration(cur) * time.Millisecond)
		}
		snap := buildMemSnapshot()
		b, err := json.Marshal(snap)
		if err != nil {
			continue
		}
		h.pushEvent("mem", b)
	}
}
