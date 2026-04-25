package main

import (
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

type MinFdFrame struct {
	Devices []struct {
		Fdinfo     map[string]struct{ Name string } `json:"fdinfo"`
		XdnaFdinfo map[string]struct{ Name string } `json:"xdna_fdinfo"`
	} `json:"devices"`
}

func PopulateGPUProcCache(h *Hub, cache *GPUProcCache) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.Lock()
		raw := h.last
		h.mu.Unlock()
		if raw == nil {
			continue
		}
		var frame MinFdFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		for _, dev := range frame.Devices {
			for _, p := range dev.Fdinfo {
				if p.Name != "" && cache.Add(p.Name) {
					log.Printf("gpu proc cache: learned %q", p.Name)
				}
			}
			for _, p := range dev.XdnaFdinfo {
				if p.Name != "" && cache.Add(p.Name) {
					log.Printf("gpu proc cache: learned %q", p.Name)
				}
			}
		}
	}
}
