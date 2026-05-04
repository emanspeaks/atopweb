package main

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type hub struct {
	mu                sync.Mutex
	clients           map[*websocket.Conn]struct{}
	last              []byte
	intervalMs        int
	showGttMargin     bool
	cancelFn          context.CancelFunc
	atopVersion       string          // amdgpu_top version string
	ryzenAdjArgs      []string        // nil if not configured; includes sudo prefix when needed
	powerCache        powerLimitsInfo // last successful ryzenadj result
	limitsRefreshedAt time.Time       // when powerCache was last written
	dramMaxBWKiBs     uint64          // theoretical DRAM bandwidth ceiling from dmidecode
}

func (h *hub) add(c *websocket.Conn) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *hub) remove(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

// broadcast sends msg to all connected clients and updates h.last.
// h.last holds the most recent GPU frame for /api/vram, /api/gpu-pct, etc.
func (h *hub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.last = msg
	for c := range h.clients {
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			c.Close()
			delete(h.clients, c)
		}
	}
}

// pushAll sends msg to all connected clients without updating h.last.
// Used for non-GPU push frames (system info, etc.) so that h.last always
// holds the most recent GPU frame.
func (h *hub) pushAll(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			c.Close()
			delete(h.clients, c)
		}
	}
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	h.add(conn)
	defer h.remove(conn)
	// drain client frames to detect disconnection
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}
