package main

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// drmProcessMem is one per-process DRM memory snapshot derived from
// /proc/<pid>/fdinfo/<fd> for every DRM file descriptor a process holds.
// Values are KiB (matching the fdinfo wire format) and per-process aggregates
// across all of that process's DRM FDs.
type drmProcessMem struct {
	PID              int    `json:"pid"`
	Comm             string `json:"comm,omitempty"`
	Cmdline          string `json:"cmdline,omitempty"`             // /proc/<pid>/cmdline, args joined with spaces
	Driver           string `json:"driver,omitempty"`              // e.g. "amdgpu"
	PssAnonKiB       uint64 `json:"pss_anon_kib,omitempty"`        // /proc/<pid>/smaps_rollup Pss_Anon
	AnonHugePagesKiB uint64 `json:"anon_huge_pages_kib,omitempty"` // /proc/<pid>/smaps_rollup AnonHugePages
	VramKiB          uint64 `json:"vram_kib,omitempty"`            // drm-memory-vram
	GttKiB           uint64 `json:"gtt_kib,omitempty"`             // drm-memory-gtt
	CpuKiB           uint64 `json:"cpu_kib,omitempty"`             // drm-memory-cpu  (system-RAM pinned by the driver)
	VisVramKiB       uint64 `json:"vis_vram_kib,omitempty"`        // amd-memory-visible-vram
}

// drmAccounting bundles everything we know about graphics-subsystem memory
// from three sources:
//  1. /proc/<pid>/fdinfo/<fd>                   — per-process DRM usage
//  2. /sys/class/drm/card*/device/mem_info_*    — kernel-authoritative per-GPU
//     totals (VRAM total/used, CPU-visible VRAM, GTT)
//  3. /sys/kernel/debug/dma_buf/bufinfo         — dma-buf allocations
//
// Fields ending *KiB come from (2) (byte-exact from sysfs, expressed as KiB).
// Total*KiB come from (1).  DmaBufBytes is separate because dma-bufs can be
// backed by VRAM, GTT, or system memory — we report it informationally, not as
// an accounting line.
type drmAccounting struct {
	VramTotalKiB    uint64          `json:"vram_total_kib,omitempty"`
	VramUsedKiB     uint64          `json:"vram_used_kib,omitempty"`
	VisVramTotalKiB uint64          `json:"vis_vram_total_kib,omitempty"`
	VisVramUsedKiB  uint64          `json:"vis_vram_used_kib,omitempty"`
	GttTotalKiB     uint64          `json:"gtt_total_kib,omitempty"`
	GttUsedKiB      uint64          `json:"gtt_used_kib,omitempty"`
	TotalVramKiB    uint64          `json:"total_vram_kib,omitempty"` // sum of per-fd drm-memory-vram
	TotalGttKiB     uint64          `json:"total_gtt_kib,omitempty"`  // sum of per-fd drm-memory-gtt
	TotalCpuKiB     uint64          `json:"total_cpu_kib,omitempty"`  // sum of per-fd drm-memory-cpu
	Processes       []drmProcessMem `json:"processes,omitempty"`
}

// readDRMSysfs pulls authoritative per-GPU memory totals from
// /sys/class/drm/card*/device/mem_info_*.  These are populated by the amdgpu
// kernel driver and are byte-exact.  Multiple cards are summed.
func readDRMSysfs(a *drmAccounting) {
	cards, _ := filepath.Glob("/sys/class/drm/card[0-9]*")
	for _, c := range cards {
		// Skip connectors (card1-DP-1 etc.) — only the card root has mem_info.
		if strings.Contains(filepath.Base(c), "-") {
			continue
		}
		readUint := func(name string) uint64 {
			v, _ := strconv.ParseUint(readFileTrim(filepath.Join(c, "device", name)), 10, 64)
			return v
		}
		const toKiB = 1024
		a.VramTotalKiB += readUint("mem_info_vram_total") / toKiB
		a.VramUsedKiB += readUint("mem_info_vram_used") / toKiB
		a.VisVramTotalKiB += readUint("mem_info_vis_vram_total") / toKiB
		a.VisVramUsedKiB += readUint("mem_info_vis_vram_used") / toKiB
		a.GttTotalKiB += readUint("mem_info_gtt_total") / toKiB
		a.GttUsedKiB += readUint("mem_info_gtt_used") / toKiB
	}
}

// readDRMFdinfo walks /proc/<pid>/fd and, for every symlink pointing at
// /dev/dri/*, parses the matching /proc/<pid>/fdinfo/<fd> for drm-memory-*
// lines.  Per-process totals are accumulated across all of that PID's DRM FDs.
func readDRMFdinfo(a *drmAccounting) {
	procs, _ := filepath.Glob("/proc/[0-9]*")
	byPID := make(map[int]*drmProcessMem, 16)
	var permDenied int
	for _, procDir := range procs {
		pidStr := filepath.Base(procDir)
		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}
		fdDir := filepath.Join(procDir, "fd")
		entries, err := os.ReadDir(fdDir)
		if err != nil {
			if os.IsPermission(err) {
				permDenied++
			}
			continue
		}
		for _, ent := range entries {
			target, err := os.Readlink(filepath.Join(fdDir, ent.Name()))
			if err != nil || !strings.HasPrefix(target, "/dev/dri/") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(procDir, "fdinfo", ent.Name()))
			if err != nil {
				continue
			}
			p := byPID[pid]
			if p == nil {
				comm := readFileTrim(filepath.Join(procDir, "comm"))
				cmdlineRaw, _ := os.ReadFile(filepath.Join(procDir, "cmdline"))
				cmdline := strings.TrimRight(strings.ReplaceAll(string(cmdlineRaw), "\x00", " "), " ")
				p = &drmProcessMem{PID: pid, Comm: comm, Cmdline: cmdline}
				byPID[pid] = p
			}
			for _, line := range strings.Split(string(data), "\n") {
				colon := strings.IndexByte(line, ':')
				if colon < 0 {
					continue
				}
				key := strings.TrimSpace(line[:colon])
				valStr := strings.TrimSpace(line[colon+1:])
				parseKiB := func() uint64 {
					f := strings.Fields(valStr)
					if len(f) == 0 {
						return 0
					}
					v, _ := strconv.ParseUint(f[0], 10, 64)
					return v
				}
				switch key {
				case "drm-driver":
					if p.Driver == "" {
						p.Driver = valStr
					}
				case "drm-memory-vram":
					p.VramKiB += parseKiB()
				case "drm-memory-gtt":
					p.GttKiB += parseKiB()
				case "drm-memory-cpu":
					p.CpuKiB += parseKiB()
				case "amd-memory-visible-vram":
					p.VisVramKiB += parseKiB()
				}
			}
		}
	}
	for _, p := range byPID {
		if p.VramKiB == 0 && p.GttKiB == 0 && p.CpuKiB == 0 {
			continue // xorg/wayland holding a DRM fd with no BOs — skip
		}
		a.TotalVramKiB += p.VramKiB
		a.TotalGttKiB += p.GttKiB
		a.TotalCpuKiB += p.CpuKiB
		a.Processes = append(a.Processes, *p)
	}
	// Sort biggest first for UI convenience.
	sort.Slice(a.Processes, func(i, j int) bool {
		ai := a.Processes[i].VramKiB + a.Processes[i].GttKiB + a.Processes[i].CpuKiB
		aj := a.Processes[j].VramKiB + a.Processes[j].GttKiB + a.Processes[j].CpuKiB
		return ai > aj
	})
	if permDenied > 0 {
		diag.report("DRM fdinfo scan: permission denied on /proc/*/fd — per-process DRM memory totals are incomplete until the service gains CAP_SYS_PTRACE")
	}
}

// readDRMAccounting assembles the full per-GPU + per-process report.
func readDRMAccounting() *drmAccounting {
	a := &drmAccounting{}
	readDRMSysfs(a)
	readDRMFdinfo(a)
	if a.VramTotalKiB == 0 && len(a.Processes) == 0 {
		return nil
	}
	return a
}
