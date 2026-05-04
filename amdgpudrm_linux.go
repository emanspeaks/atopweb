//go:build linux

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	amdgpu "github.com/emanspeaks/amdgpu-go"
)

// grbmGUIActive is GRBM_STATUS bit 31, set whenever the GFX pipeline is active.
const grbmGUIActive = uint32(1 << 31)

// enumerateGPUDevices opens all /dev/dri/renderD* AMD GPU devices it can find.
// Devices that fail to open are logged and skipped (graceful per-device degradation).
func enumerateGPUDevices() (indices []int, devices []*amdgpu.Device) {
	for card := 0; card < 16; card++ {
		path := fmt.Sprintf("/dev/dri/renderD%d", 128+card)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		dev, err := amdgpu.Open(card)
		if err != nil {
			log.Printf("amdgpudrm: skipping renderD%d: %v", 128+card, err)
			continue
		}
		indices = append(indices, card)
		devices = append(devices, dev)
	}
	return
}

// readGPUName tries to resolve a human-readable product name from sysfs.
// Falls back to "AMD GPU N" if no name is found.
func readGPUName(card int) string {
	p := fmt.Sprintf("/sys/class/drm/card%d/device/product_name", card)
	if data, err := os.ReadFile(p); err == nil {
		if name := strings.TrimSpace(string(data)); name != "" {
			return name
		}
	}
	return fmt.Sprintf("AMD GPU %d", card)
}

// drmGPUStats holds one polling cycle's readings for a single GPU.
type drmGPUStats struct {
	Name         string
	GFXPct       float64
	VRAMUsedMiB  float64
	VRAMTotalMiB float64
	GTTUsedMiB   float64
	GTTTotalMiB  float64
}

func buildDRMFrame(stats []drmGPUStats) ([]byte, error) {
	type valEntry struct {
		Value float64 `json:"value"`
	}
	type drmDevice struct {
		Info     map[string]interface{} `json:"Info"`
		Activity map[string]valEntry   `json:"gpu_activity"`
		VRAM     map[string]valEntry   `json:"VRAM"`
		Metrics  map[string]interface{} `json:"gpu_metrics"`
	}
	devs := make([]drmDevice, len(stats))
	for i, s := range stats {
		devs[i] = drmDevice{
			Info: map[string]interface{}{
				"DeviceName": s.Name,
				"ASIC Name":  s.Name,
			},
			Activity: map[string]valEntry{
				"GFX": {Value: s.GFXPct},
			},
			VRAM: map[string]valEntry{
				"Total VRAM Usage": {Value: s.VRAMUsedMiB},
				"Total VRAM":       {Value: s.VRAMTotalMiB},
				"Total GTT Usage":  {Value: s.GTTUsedMiB},
				"Total GTT":        {Value: s.GTTTotalMiB},
			},
			Metrics: map[string]interface{}{},
		}
	}
	frame := struct {
		Devices []drmDevice `json:"devices"`
	}{Devices: devs}
	return json.Marshal(frame)
}

// runDRMPoller replaces runStreamer when --use-drm is set.
// It enumerates AMD GPU devices via libdrm, samples GRBM registers for GFX
// activity, reads memory stats, and broadcasts atopFrame-compatible JSON.
// noPC mirrors amdgpu_top's --no-pc: skip GRBM reads and report 0% GFX.
func runDRMPoller(h *hub, noPC bool) {
	const grbmSamples = 32

	for {
		indices, devices := enumerateGPUDevices()
		if len(devices) == 0 {
			log.Printf("amdgpudrm: no devices opened; retrying in 5s")
			time.Sleep(5 * time.Second)
			continue
		}
		log.Printf("amdgpudrm: polling %d GPU(s)", len(devices))

		failed := drmPollLoop(h, indices, devices, noPC, grbmSamples)
		for _, dev := range devices {
			dev.Close()
		}
		if failed {
			log.Printf("amdgpudrm: device error; re-enumerating in 5s")
			time.Sleep(5 * time.Second)
		}
	}
}

// drmPollLoop runs the inner polling loop for the given open devices.
// Returns true if a device error caused early exit.
func drmPollLoop(h *hub, indices []int, devices []*amdgpu.Device, noPC bool, grbmSamples int) bool {
	for {
		h.mu.Lock()
		intervalMs := h.intervalMs
		h.mu.Unlock()
		intervalDur := time.Duration(intervalMs) * time.Millisecond

		start := time.Now()

		// Sample GRBM for GFX activity across the first 80% of the interval so
		// memory reads fit within the remaining 20%.
		gfxCounts := make([]int, len(devices))
		if !noPC {
			sampleDur := intervalDur * 8 / 10
			sleepPer := sampleDur / time.Duration(grbmSamples)
			for samp := 0; samp < grbmSamples; samp++ {
				for i, dev := range devices {
					v, err := dev.ReadGRBM()
					if err != nil {
						log.Printf("amdgpudrm: GRBM read failed card%d: %v", indices[i], err)
						return true
					}
					if v&grbmGUIActive != 0 {
						gfxCounts[i]++
					}
				}
				time.Sleep(sleepPer)
			}
		}

		// Read memory info and build stats for each device.
		stats := make([]drmGPUStats, len(devices))
		for i, dev := range devices {
			stats[i].Name = readGPUName(indices[i])
			if noPC {
				stats[i].GFXPct = 0
			} else {
				stats[i].GFXPct = float64(gfxCounts[i]) / float64(grbmSamples) * 100
			}

			mem, err := dev.MemoryInfo()
			if err != nil {
				log.Printf("amdgpudrm: MemoryInfo failed card%d: %v", indices[i], err)
				return true
			}
			const mib = 1 << 20
			stats[i].VRAMUsedMiB = float64(mem.VRAMHeapUsage) / mib
			stats[i].VRAMTotalMiB = float64(mem.VRAMTotalHeapSize) / mib
			stats[i].GTTUsedMiB = float64(mem.GTTHeapUsage) / mib
			stats[i].GTTTotalMiB = float64(mem.GTTTotalHeapSize) / mib
		}

		frame, err := buildDRMFrame(stats)
		if err != nil {
			log.Printf("amdgpudrm: frame marshal error: %v", err)
		} else {
			h.broadcast(frame)
		}

		// Sleep out the rest of the interval.
		if rem := intervalDur - time.Since(start); rem > 0 {
			time.Sleep(rem)
		}
	}
}
