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

	"github.com/gorilla/websocket"
)

type ProcEvent struct {
	Type   string `json:"type"`
	Event  string `json:"event"`
	PID    int    `json:"pid"`
	Name   string `json:"name"`
	TimeMs int64  `json:"time_ms"`
}

type ProcEventTracker struct {
	mu      sync.Mutex
	started map[int]bool
}

func NewProcEventTracker() *ProcEventTracker {
	t := &ProcEventTracker{started: make(map[int]bool)}
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

func (t *ProcEventTracker) TryStart(pid int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.started[pid] {
		return false
	}
	t.started[pid] = true
	return true
}

func (t *ProcEventTracker) Clear(pid int) {
	t.mu.Lock()
	delete(t.started, pid)
	t.mu.Unlock()
}

type GPUProcCache struct {
	mu    sync.RWMutex
	names map[string]bool
	path  string
}

func LoadGPUProcCache(path string) *GPUProcCache {
	c := &GPUProcCache{names: make(map[string]bool), path: path}
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

func (c *GPUProcCache) Has(name string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.names[name]
}

func (c *GPUProcCache) Add(name string) bool {
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

func (c *GPUProcCache) saveUnlocked() {
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

func ReadProcName(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}
