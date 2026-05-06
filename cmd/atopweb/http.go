package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"strconv"
	"time"
)

type configInfo struct {
	IntervalMs      int    `json:"interval_ms"`
	ShowGttMargin   bool   `json:"show_gtt_margin"`
	AtopwebVersion  string `json:"atopweb_version"`
	AtopTopVersion  string `json:"amdgpu_top_version"`
	BackendName     string `json:"backend_name,omitempty"`
	TotalRAMMiB     uint64 `json:"total_ram_mib"`
	KernelVersion   string `json:"kernel_version,omitempty"`
	NixosVersion    string `json:"nixos_version,omitempty"`
	NixosGeneration int    `json:"nixos_generation,omitempty"`
	CPUGovernor     string `json:"cpu_gov,omitempty"`
	DRAMMaxBWKiBs   uint64 `json:"dram_max_bw_kibs,omitempty"`
}

func buildConfigJSON(h *hub) ([]byte, error) {
	mem := readMemInfoAll()
	total := mem["MemTotal"] / 1024
	nixosVer, nixosGen := readNixosInfo()
	kernelVer := readKernelVersion()
	cpuGov := readCPUGovernor()
	h.mu.Lock()
	info := configInfo{
		IntervalMs:      h.intervalMs,
		ShowGttMargin:   h.showGttMargin,
		AtopwebVersion:  version,
		AtopTopVersion:  h.atopVersion,
		BackendName:     h.backendName,
		TotalRAMMiB:     total,
		KernelVersion:   kernelVer,
		NixosVersion:    nixosVer,
		NixosGeneration: nixosGen,
		CPUGovernor:     cpuGov,
		DRAMMaxBWKiBs:   h.dramMaxBWKiBs,
	}
	h.mu.Unlock()
	return json.Marshal(info)
}

// buildInitFrames assembles the SSE frames sent to every new client on connect:
// config, limits, cpu-ranks, and an initial system snapshot.  This replaces the
// four REST calls the browser previously made at startup.
func buildInitFrames(h *hub) []byte {
	var out []byte

	if b, err := buildConfigJSON(h); err == nil {
		out = append(out, sseFrame("config", b)...)
	}

	h.mu.Lock()
	lim := h.powerCache
	h.mu.Unlock()
	if b, err := json.Marshal(lim); err == nil {
		out = append(out, sseFrame("limits", b)...)
	}

	coreRanksOnce.Do(func() { coreRanksData = readCoreRanks() })
	ranks := coreRanksData
	if ranks == nil {
		ranks = []int{}
	}
	if b, err := json.Marshal(map[string][]int{"ranks": ranks}); err == nil {
		out = append(out, sseFrame("cpu-ranks", b)...)
	}

	if b, err := json.Marshal(buildSystemInfo()); err == nil {
		out = append(out, sseFrame("system", b)...)
	}

	if b, err := json.Marshal(buildMemSnapshot()); err == nil {
		out = append(out, sseFrame("mem", b)...)
	}

	return out
}

func (h *hub) serveConfig(w http.ResponseWriter, r *http.Request) {
	b, err := buildConfigJSON(h)
	if err != nil {
		http.Error(w, "encode error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(b)
}

func (h *hub) serveSetInterval(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	ms, err := strconv.Atoi(r.URL.Query().Get("ms"))
	if err != nil || ms < 50 || ms > 60000 {
		http.Error(w, "ms must be 50–60000", http.StatusBadRequest)
		return
	}

	h.mu.Lock()
	old := h.intervalMs
	h.intervalMs = ms
	cancel := h.cancelFn
	h.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	log.Printf("update interval: %d ms → %d ms", old, ms)
	if b, err := buildConfigJSON(h); err == nil {
		h.pushEvent("config", b)
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── /api/vram ────────────────────────────────────────────────────────────────

type atopFrame struct {
	Devices []atopDevice `json:"devices"`
}

type atopDevice struct {
	Info     map[string]interface{} `json:"Info"`
	Activity map[string]struct {
		Value float64 `json:"value"`
	} `json:"gpu_activity"`
	VRAM map[string]struct {
		Value float64 `json:"value"`
	} `json:"VRAM"`
	GPUMetrics struct {
		STAPMPowerLimit        *float64 `json:"stapm_power_limit"`
		CurrentSTAPMPowerLimit *float64 `json:"current_stapm_power_limit"`
	} `json:"gpu_metrics"`
}

type vramInfo struct {
	Name     string  `json:"name"`
	UsedMiB  float64 `json:"used_mib"`
	TotalMiB float64 `json:"total_mib"`
	UsedPct  float64 `json:"used_pct"`
}

func (h *hub) serveVRAM(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	raw := h.last
	h.mu.Unlock()

	if raw == nil {
		http.Error(w, "no data yet", http.StatusServiceUnavailable)
		return
	}

	var frame atopFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		http.Error(w, "parse error", http.StatusInternalServerError)
		return
	}

	result := make([]vramInfo, 0, len(frame.Devices))
	for i, dev := range frame.Devices {
		used := dev.VRAM["Total VRAM Usage"].Value + dev.VRAM["Total GTT Usage"].Value
		total := dev.VRAM["Total VRAM"].Value + dev.VRAM["Total GTT"].Value
		var pct float64
		if total > 0 {
			pct = used / total * 100
		}
		name := fmt.Sprintf("GPU %d", i)
		if n, ok := dev.Info["DeviceName"].(string); ok && n != "" {
			name = n
		} else if n, ok := dev.Info["ASIC Name"].(string); ok && n != "" {
			name = n
		}
		result = append(result, vramInfo{
			Name:     name,
			UsedMiB:  used,
			TotalMiB: total,
			UsedPct:  pct,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// ── /api/gpu-pct ──────────────────────────────────────────────────────────────

type gpuPctInfo struct {
	Name   string  `json:"name"`
	GpuPct float64 `json:"gpu_pct"`
}

func (h *hub) serveGPUPct(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	raw := h.last
	h.mu.Unlock()

	if raw == nil {
		http.Error(w, "no data yet", http.StatusServiceUnavailable)
		return
	}

	var frame atopFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		http.Error(w, "parse error", http.StatusInternalServerError)
		return
	}

	result := make([]gpuPctInfo, 0, len(frame.Devices))
	for i, dev := range frame.Devices {
		name := fmt.Sprintf("GPU %d", i)
		if n, ok := dev.Info["DeviceName"].(string); ok && n != "" {
			name = n
		} else if n, ok := dev.Info["ASIC Name"].(string); ok && n != "" {
			name = n
		}
		result = append(result, gpuPctInfo{
			Name:   name,
			GpuPct: dev.Activity["GFX"].Value,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// powerLimitsInfo is defined in power.go

func (h *hub) refreshPowerLimits() {
	if len(h.ryzenAdjArgs) == 0 {
		return
	}
	out, err := exec.Command(h.ryzenAdjArgs[0], h.ryzenAdjArgs[1:]...).Output()
	var result powerLimitsInfo
	if err != nil {
		log.Printf("ryzenadj error: %v", err)
	} else {
		result = parseRyzenAdjInfo(string(out))
		if result.STAPMWatts == nil && result.FastWatts == nil && result.SlowWatts == nil {
			log.Printf("ryzenadj: parsed no limits; raw output:\n%s", string(out))
		}
	}
	h.mu.Lock()
	h.powerCache = result
	h.limitsRefreshedAt = time.Now()
	lim := h.powerCache
	h.mu.Unlock()
	if b, err := json.Marshal(lim); err == nil {
		h.pushEvent("limits", b)
	}
}

func (h *hub) serveLimits(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	stale := len(h.ryzenAdjArgs) > 0 && time.Since(h.limitsRefreshedAt) > 30*time.Second
	h.mu.Unlock()
	if stale {
		h.refreshPowerLimits()
	}

	h.mu.Lock()
	result := h.powerCache
	h.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}
