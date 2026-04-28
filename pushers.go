package main

import (
	"encoding/json"
	"time"
)

// wsSysFrame is the WebSocket envelope for server-pushed system data.
// The "type" field lets the client dispatcher route it before the GPU-frame path.
type wsSysFrame struct {
	Type string `json:"type"`
	systemInfo
}

// wsMemFrame is the WebSocket envelope for fast-refresh memory snapshots pushed
// at the amdgpu_top sample cadence.
type wsMemFrame struct {
	Type string `json:"type"`
	memSnapshot
}

// runSystemPusher pushes a system-info frame over the WebSocket to all
// connected clients once per second.  It uses pushAll (not broadcast) so
// h.last always holds the last GPU frame.
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
		frame := wsSysFrame{Type: "system", systemInfo: info}
		b, err := json.Marshal(frame)
		if err != nil {
			continue
		}
		h.pushAll(b)
	}
}

// runMemPusher pushes a fast-refresh memory snapshot over WebSocket at the same
// cadence as amdgpu_top (h.intervalMs), automatically adjusting when the
// interval is changed via /api/interval.  Uses pushAll so h.last always holds
// the most recent GPU frame.
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
		frame := wsMemFrame{Type: "mem", memSnapshot: snap}
		b, err := json.Marshal(frame)
		if err != nil {
			continue
		}
		h.pushAll(b)
	}
}
