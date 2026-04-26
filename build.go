package main

import (
	"encoding/json"
	"net/http"
)

// sysSensor represents a single hardware monitoring sensor reading.
type sysSensor struct {
	Chip  string  `json:"chip"`
	Label string  `json:"label"`
	Value float64 `json:"value"`
}

// memSnapshot holds the fast-changing memory fields pushed at the amdgpu_top
// sample cadence rather than the fixed 1 Hz system cadence.
type memSnapshot struct {
	MemInfoKB    map[string]uint64 `json:"meminfo_kb,omitempty"` // all /proc/meminfo fields in kB
	DRMMem       *drmAccounting    `json:"drm_mem,omitempty"`    // per-process DRM memory breakdown from /proc/*/fdinfo
	SockMemKB    uint64            `json:"sock_mem_kb"`          // kernel network-stack page allocations
	DmaBufBytes  uint64            `json:"dma_buf_bytes"`        // total dma-buf bytes across all exporters
	GpuAnonPssKB uint64            `json:"gpu_anon_pss_kb"`      // Σ Pss_Anon across PIDs in DRMMem.Processes
	DRAMReadBps  uint64            `json:"dram_read_bps"`        // DRAM read bandwidth in bytes/sec
	DRAMWriteBps uint64            `json:"dram_write_bps"`       // DRAM write bandwidth in bytes/sec
}

// systemInfo holds system-wide stats not specific to a GPU: memory, uptime,
// load, and every hwmon sensor the kernel exposes.
type systemInfo struct {
	TotalRAMMiB         uint64         `json:"total_ram_mib"`
	AvailRAMMiB         uint64         `json:"avail_ram_mib"`
	FirmwareReservedKiB uint64         `json:"firmware_reserved_kib,omitempty"` // DRAM reserved above top-of-System-RAM
	MemReservation      memReservation `json:"mem_reservation,omitempty"`       // full authoritative memory-topology report
	Errors              []string       `json:"errors,omitempty"`                // sticky non-fatal diagnostics
	ShutdownPending     string         `json:"shutdown_pending,omitempty"`      // non-empty when systemd has a shutdown/reboot scheduled
	UptimeSec           float64        `json:"uptime_sec"`
	LoadAvg             [3]float64     `json:"loadavg"`
	Fans                []sysSensor    `json:"fans"`                    // RPM
	Voltages            []sysSensor    `json:"voltages"`                // mV
	Currents            []sysSensor    `json:"currents"`                // mA
	Powers              []sysSensor    `json:"powers"`                  // µW
	Temps               []sysSensor    `json:"temps"`                   // °C
	CPUUsagePct         *float64       `json:"cpu_usage_pct,omitempty"` // 0–100; absent on first tick
}

func buildMemSnapshot() memSnapshot {
	drm := readDRMAccounting()
	var gpuAnonPss uint64
	if drm != nil && len(drm.Processes) > 0 {
		pids := make([]int, 0, len(drm.Processes))
		for _, p := range drm.Processes {
			pids = append(pids, p.PID)
		}
		byPid := readAnonStatsByPid(pids)
		for i := range drm.Processes {
			s := byPid[drm.Processes[i].PID]
			drm.Processes[i].PssAnonKiB = s.PssAnonKiB
			drm.Processes[i].AnonHugePagesKiB = s.AnonHugePagesKiB
			gpuAnonPss += s.PssAnonKiB
		}
	}
	readBps, writeBps, _ := readDRAMBW()
	return memSnapshot{
		MemInfoKB:    readMemInfoAll(),
		DRMMem:       drm,
		SockMemKB:    readSockMemKB(),
		DmaBufBytes:  readDmaBufBytes(),
		GpuAnonPssKB: gpuAnonPss,
		DRAMReadBps:  readBps,
		DRAMWriteBps: writeBps,
	}
}

func buildSystemInfo() systemInfo {
	fans, volts, currs, pows, temps := readHwmon()
	memInfo := readMemInfoAll()
	memRes := readMemReservation()
	return systemInfo{
		TotalRAMMiB:         memInfo["MemTotal"] / 1024,
		AvailRAMMiB:         memInfo["MemAvailable"] / 1024,
		FirmwareReservedKiB: memRes.FirmwareReservedKiB,
		MemReservation:      memRes,
		Errors:              diag.snapshot(),
		ShutdownPending:     checkShutdownPending(),
		UptimeSec:           readUptime(),
		LoadAvg:             readLoadAvg(),
		Fans:                fans,
		Voltages:            volts,
		Currents:            currs,
		Powers:              pows,
		Temps:               temps,
	}
}

func serveSystem(w http.ResponseWriter, r *http.Request) {
	type fullSystem struct {
		systemInfo
		memSnapshot
	}
	info := fullSystem{
		systemInfo:  buildSystemInfo(),
		memSnapshot: buildMemSnapshot(),
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(info)
}
