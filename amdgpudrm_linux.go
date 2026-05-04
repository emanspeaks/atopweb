//go:build linux && cgo

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

const drmAvailable = true

// ── GPU generation detection ─────────────────────────────────────────────────

type amdgpuGen int

const (
	genUnknown amdgpuGen = iota
	genGFX9
	genGFX10
	genGFX10_3
	genGFX11
	genGFX12
)

// detectGeneration maps an AMDGPU family ID to a chip generation used to pick
// the correct GRBM2 register bit layout.
func detectGeneration(family uint32) amdgpuGen {
	switch family {
	case 141, 142: // FAMILY_AI (Vega), FAMILY_RV (Raven APU)
		return genGFX9
	case 143: // FAMILY_NV (Navi10/12/14)
		return genGFX10
	case 144, 145, 146: // VGH (Van Gogh), YC (Yellow Carp / Rembrandt)
		return genGFX10_3
	case 147, 148, 149: // GFX11 discrete and APU (Navi31, Phoenix)
		return genGFX11
	case 150, 151: // GFX12 (Navi48)
		return genGFX12
	default:
		return genUnknown
	}
}

// ── GRBM / GRBM2 bit mask tables ─────────────────────────────────────────────

type bitEntry struct {
	Name string
	Bit  uint
}

// grbmBits lists the GRBM_STATUS bits matched to the frontend GRBM_KEYS.
// Bit positions are the same across GFX10+ hardware.
var grbmBits = []bitEntry{
	{"Graphics Pipe", 31},
	{"Texture Pipe", 14},
	{"Shader Export", 20},
	{"Shader Processor Interpolator", 22},
	{"Primitive Assembly", 25},
	{"Depth Block", 26},
	{"Color Block", 30},
	{"Geometry Engine", 21},
}

// grbm2BitsForGen returns the GRBM2_STATUS bit table for the given generation.
// Bit positions sourced from amdgpu_top crates/libamdgpu_top/src/stat/mod.rs.
func grbm2BitsForGen(gen amdgpuGen) []bitEntry {
	// Base entries shared across GFX9+
	baseCP := []bitEntry{
		{"Unified Translation Cache Level-2", 15},
		{"Efficiency Arbiter", 16},
		{"Command Processor -  Fetcher", 28},
		{"Command Processor -  Compute", 29},
		{"Command Processor - Graphics", 30},
	}

	switch gen {
	case genGFX9:
		// GFX9_GRBM2_INDEX: RLC=24, TCP=25, RMI=17, no SDMA
		return append([]bitEntry{
			{"RunList Controller", 24},
			{"Texture Cache per Pipe", 25},
			{"Render Backend Memory Interface", 17},
		}, baseCP...)

	case genGFX10:
		// GFX10_GRBM2_INDEX: RLC=24, TCP=25, RMI=17, SDMA=21
		return append([]bitEntry{
			{"RunList Controller", 24},
			{"Texture Cache per Pipe", 25},
			{"Render Backend Memory Interface", 17},
			{"SDMA", 21},
		}, baseCP...)

	case genGFX12:
		// GFX12_GRBM2_INDEX: RLC=26, TCP=27, SDMA=21 — no RMI
		return append([]bitEntry{
			{"RunList Controller", 26},
			{"Texture Cache per Pipe", 27},
			{"SDMA", 21},
		}, baseCP...)

	default:
		// GFX10.3 and GFX11 both use GFX10_3_GRBM2_INDEX: RLC=26, TCP=27, RMI=17, SDMA=21
		return append([]bitEntry{
			{"RunList Controller", 26},
			{"Texture Cache per Pipe", 27},
			{"Render Backend Memory Interface", 17},
			{"SDMA", 21},
		}, baseCP...)
	}
}

// ── GPU stats struct ──────────────────────────────────────────────────────────

// drmGPUStats holds one polling cycle's readings for a single GPU.
type drmGPUStats struct {
	Name         string
	GFXPct       float64
	VRAMUsedMiB  float64
	VRAMTotalMiB float64
	GTTUsedMiB   float64
	GTTTotalMiB  float64
	GRBMPct      map[string]float64 // per-engine GRBM percentages
	GRBM2Pct     map[string]float64 // per-engine GRBM2 percentages
	Sensors      map[string]float64 // hwmon + sysfs clocks
	GPUMetrics   map[string]interface{}
	Fdinfo       map[string]interface{}
}

// ── Device enumeration ────────────────────────────────────────────────────────

// enumerateGPUDevices opens all /dev/dri/renderD* AMD GPU devices it can find.
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
func readGPUName(card int) string {
	p := fmt.Sprintf("/sys/class/drm/card%d/device/product_name", card)
	if data, err := os.ReadFile(p); err == nil {
		if name := strings.TrimSpace(string(data)); name != "" {
			return name
		}
	}
	return fmt.Sprintf("AMD GPU %d", card)
}

// ── JSON frame builder ────────────────────────────────────────────────────────

func buildDRMFrame(stats []drmGPUStats) ([]byte, error) {
	type valEntry struct {
		Value float64 `json:"value"`
	}
	type drmDevice struct {
		Info       map[string]interface{} `json:"Info"`
		Activity   map[string]valEntry    `json:"gpu_activity"`
		VRAM       map[string]valEntry    `json:"VRAM"`
		Sensors    map[string]valEntry    `json:"Sensors"`
		GPUMetrics map[string]interface{} `json:"gpu_metrics"`
		GRBM       map[string]valEntry    `json:"GRBM"`
		GRBM2      map[string]valEntry    `json:"GRBM2"`
		Fdinfo     map[string]interface{} `json:"fdinfo"`
	}

	devs := make([]drmDevice, len(stats))
	for i, s := range stats {
		sensors := make(map[string]valEntry, len(s.Sensors))
		for k, v := range s.Sensors {
			sensors[k] = valEntry{v}
		}
		grbm := make(map[string]valEntry, len(s.GRBMPct))
		for k, v := range s.GRBMPct {
			grbm[k] = valEntry{v}
		}
		grbm2 := make(map[string]valEntry, len(s.GRBM2Pct))
		for k, v := range s.GRBM2Pct {
			grbm2[k] = valEntry{v}
		}
		gm := s.GPUMetrics
		if gm == nil {
			gm = map[string]interface{}{}
		}
		fi := s.Fdinfo
		if fi == nil {
			fi = map[string]interface{}{}
		}

		devs[i] = drmDevice{
			Info: map[string]interface{}{
				"DeviceName": s.Name,
				"ASIC Name":  s.Name,
			},
			Activity: map[string]valEntry{
				"GFX": {s.GFXPct},
			},
			VRAM: map[string]valEntry{
				"Total VRAM Usage": {s.VRAMUsedMiB},
				"Total VRAM":       {s.VRAMTotalMiB},
				"Total GTT Usage":  {s.GTTUsedMiB},
				"Total GTT":        {s.GTTTotalMiB},
			},
			Sensors:    sensors,
			GPUMetrics: gm,
			GRBM:       grbm,
			GRBM2:      grbm2,
			Fdinfo:     fi,
		}
	}
	frame := struct {
		Devices []drmDevice `json:"devices"`
	}{Devices: devs}
	return json.Marshal(frame)
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

// runDRMPoller replaces runStreamer when --use-drm is set.
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

// drmPollState holds per-device state that persists across iterations of the
// inner poll loop (GPU generation, fdinfo delta tracking).
type drmPollState struct {
	gen        amdgpuGen
	grbm2Bits  []bitEntry
	pciDev     string
	fdinfoPrev map[int]fdinfoProcSnapshot
	fdinfoTime time.Time
}

// drmPollLoop runs the inner polling loop for the given open devices.
// Returns true if a device error caused early exit.
func drmPollLoop(h *hub, indices []int, devices []*amdgpu.Device, noPC bool, grbmSamples int) bool {
	// Initialise per-device state.
	states := make([]drmPollState, len(devices))
	for i, dev := range devices {
		info, err := dev.DeviceInfo()
		if err == nil {
			gen := detectGeneration(info.Family)
			states[i].gen = gen
			states[i].grbm2Bits = grbm2BitsForGen(gen)
		} else {
			states[i].gen = genUnknown
			states[i].grbm2Bits = grbm2BitsForGen(genUnknown)
		}
		states[i].pciDev = pciDevForCard(indices[i])
		states[i].fdinfoPrev = make(map[int]fdinfoProcSnapshot)
	}

	// Read CPU Tctl once; it's not card-specific.
	cpuTctl, hasCPUTctl := readCPUTctl()
	cpuTctlRefresh := time.Now()

	for {
		h.mu.Lock()
		intervalMs := h.intervalMs
		h.mu.Unlock()
		intervalDur := time.Duration(intervalMs) * time.Millisecond

		start := time.Now()

		// Refresh CPU Tctl every ~5 seconds to keep it current without
		// hammering sysfs on every tight sample loop.
		if time.Since(cpuTctlRefresh) > 5*time.Second {
			cpuTctl, hasCPUTctl = readCPUTctl()
			cpuTctlRefresh = start
		}

		// ── GRBM/GRBM2 sampling ───────────────────────────────────────────
		// Count bit-set samples for each GRBM and GRBM2 bit across the first
		// 80% of the interval so memory reads fit in the remaining 20%.
		type bitCounts struct {
			grbm  [32]int
			grbm2 [32]int
		}
		counts := make([]bitCounts, len(devices))

		if !noPC {
			sampleDur := intervalDur * 8 / 10
			sleepPer := sampleDur / time.Duration(grbmSamples)
			for samp := 0; samp < grbmSamples; samp++ {
				for i, dev := range devices {
					g, err := dev.ReadGRBM()
					if err != nil {
						log.Printf("amdgpudrm: GRBM read failed card%d: %v", indices[i], err)
						return true
					}
					for b := uint(0); b < 32; b++ {
						if g&(1<<b) != 0 {
							counts[i].grbm[b]++
						}
					}

					g2, err := dev.ReadGRBM2()
					if err != nil {
						// GRBM2 failure is non-fatal — log once, continue without it.
						log.Printf("amdgpudrm: GRBM2 read failed card%d (continuing): %v", indices[i], err)
					} else {
						for b := uint(0); b < 32; b++ {
							if g2&(1<<b) != 0 {
								counts[i].grbm2[b]++
							}
						}
					}
				}
				time.Sleep(sleepPer)
			}
		}

		// ── Per-device stats ──────────────────────────────────────────────
		stats := make([]drmGPUStats, len(devices))
		for i, dev := range devices {
			card := indices[i]
			st := &stats[i]
			st.Name = readGPUName(card)

			// GFX% from bit 31 of GRBM (GUI_ACTIVE)
			if noPC {
				st.GFXPct = 0
			} else {
				st.GFXPct = float64(counts[i].grbm[31]) / float64(grbmSamples) * 100
			}

			// Memory
			mem, err := dev.MemoryInfo()
			if err != nil {
				log.Printf("amdgpudrm: MemoryInfo failed card%d: %v", card, err)
				return true
			}
			const mib = 1 << 20
			st.VRAMUsedMiB = float64(mem.VRAMHeapUsage) / mib
			st.VRAMTotalMiB = float64(mem.VRAMTotalHeapSize) / mib
			st.GTTUsedMiB = float64(mem.GTTHeapUsage) / mib
			st.GTTTotalMiB = float64(mem.GTTTotalHeapSize) / mib

			// Per-engine GRBM percentages
			if !noPC {
				st.GRBMPct = make(map[string]float64, len(grbmBits))
				for _, e := range grbmBits {
					st.GRBMPct[e.Name] = float64(counts[i].grbm[e.Bit]) / float64(grbmSamples) * 100
				}
				st.GRBM2Pct = make(map[string]float64, len(states[i].grbm2Bits))
				for _, e := range states[i].grbm2Bits {
					st.GRBM2Pct[e.Name] = float64(counts[i].grbm2[e.Bit]) / float64(grbmSamples) * 100
				}
			}

			// Sensors (hwmon + clocks)
			st.Sensors = readDRMSensors(card, cpuTctl, hasCPUTctl)

			// gpu_metrics binary blob
			st.GPUMetrics = parseGPUMetrics(card)

			// fdinfo per-process
			now := time.Now()
			currFdinfo := scanDRMFdinfo(states[i].pciDev)
			dt := now.Sub(states[i].fdinfoTime).Seconds()
			st.Fdinfo = computeFdinfoDeltas(states[i].fdinfoPrev, currFdinfo, dt)
			states[i].fdinfoPrev = currFdinfo
			states[i].fdinfoTime = now
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
