package main

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type Hub struct {
	mu                sync.Mutex
	clients           map[*websocket.Conn]struct{}
	last              []byte
	intervalMs        int
	showGttMargin     bool
	cancelFn          context.CancelFunc
	atopVersion       string
	ryzenAdjArgs      []string
	powerCache        PowerLimitsInfo
	limitsRefreshedAt time.Time
	dramMaxBWKiBs     uint64
}

func (h *Hub) Add(c *websocket.Conn) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) Remove(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *Hub) Broadcast(msg []byte) {
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

func (h *Hub) PushAll(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			c.Close()
			delete(h.clients, c)
		}
	}
}

func (h *Hub) BroadcastProcEvent(ev ProcEvent) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.Broadcast(data)
}
