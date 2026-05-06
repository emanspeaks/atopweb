package main

import (
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const (
	sseHeartbeatPeriod = 30 * time.Second
	sseClientBuf       = 64 // outbound frames buffered per client before dropping
)

type client struct {
	send chan []byte
}

// sseFrame formats a Server-Sent Events frame.  When event is non-empty the
// "event:" line is included so the browser routes via addEventListener.
func sseFrame(event string, data []byte) []byte {
	sz := 6 + len(data) + 2 // "data: " + data + "\n\n"
	if event != "" {
		sz += 7 + len(event) + 1 // "event: " + event + "\n"
	}
	b := make([]byte, 0, sz)
	if event != "" {
		b = append(b, "event: "...)
		b = append(b, event...)
		b = append(b, '\n')
	}
	b = append(b, "data: "...)
	b = append(b, data...)
	b = append(b, '\n', '\n')
	return b
}

type hub struct {
	mu                sync.Mutex
	clients           map[*client]struct{}
	last              []byte          // raw JSON of the most recent GPU frame (for REST endpoints)
	intervalMs        int
	showGttMargin     bool
	cancelFn          context.CancelFunc
	atopVersion       string          // amdgpu_top version string (or amdgpu-go version for DRM backend)
	backendName       string          // "amdgpu_top" or "drm"
	ryzenAdjArgs      []string        // nil if not configured; includes sudo prefix when needed
	powerCache        powerLimitsInfo // last successful ryzenadj result
	limitsRefreshedAt time.Time       // when powerCache was last written
	dramMaxBWKiBs     uint64          // theoretical DRAM bandwidth ceiling from dmidecode
}

func (h *hub) remove(c *client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

// broadcast sends a GPU frame to all SSE clients and caches the raw JSON for
// REST endpoints (/api/vram, /api/gpu-pct, etc.).
// Non-blocking: a frame is dropped for a slow client rather than stalling the
// entire data pipeline.
func (h *hub) broadcast(msg []byte) {
	frame := sseFrame("gpu", msg)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.last = msg
	for c := range h.clients {
		select {
		case c.send <- frame:
		default:
		}
	}
}

// pushEvent sends a named SSE event to all clients without touching h.last.
// Used by system/memory pushers, process watchers, shutdown watchers, and
// on interval/limits changes.
func (h *hub) pushEvent(event string, data []byte) {
	frame := sseFrame(event, data)
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- frame:
		default:
		}
	}
}

func (h *hub) serveSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "SSE not supported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no") // disable nginx proxy buffering
	w.Header().Set("Access-Control-Allow-Origin", "*")

	c := &client{send: make(chan []byte, sseClientBuf)}

	// Register and snapshot h.last under the same lock so we don't miss a
	// GPU frame that broadcasts between these two steps.
	h.mu.Lock()
	h.clients[c] = struct{}{}
	lastFrame := h.last
	h.mu.Unlock()

	defer h.remove(c)

	// Push init events (config, limits, cpu-ranks, system) before streaming.
	// This replaces the four REST calls the client previously made at startup.
	if _, err := w.Write(buildInitFrames(h)); err != nil {
		return
	}
	// Prime with the most recent GPU frame so the UI doesn't wait up to one
	// full sample interval before rendering.
	if len(lastFrame) > 0 {
		if _, err := fmt.Fprintf(w, "event: gpu\ndata: %s\n\n", lastFrame); err != nil {
			return
		}
	}
	flusher.Flush()

	heartbeat := time.NewTicker(sseHeartbeatPeriod)
	defer heartbeat.Stop()

	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				return
			}
			if _, err := w.Write(msg); err != nil {
				return
			}
			flusher.Flush()
		case <-heartbeat.C:
			// SSE comment — keeps the TCP connection alive through idle proxies.
			if _, err := fmt.Fprintf(w, ":\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
