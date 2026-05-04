//go:build linux && cgo

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	amdgpu "github.com/emanspeaks/amdgpu-go"
)

// ── GFX family → chip metadata ────────────────────────────────────────────────

type chipMeta struct {
	ChipClass  string // e.g. "GFX1151"
	Name       string // e.g. "Strix Halo"
	GFXTarget  string // e.g. "gfx1151" (lowercase, matches kernel gfx_target_version)
	GPUFamily  string // e.g. "GC 11.5.0"
}

// chipMetaForFamily maps AMDGPU_FAMILY_* IDs to chip metadata.
// Family IDs from include/uapi/drm/amdgpu_drm.h.
func chipMetaForFamily(family uint32) chipMeta {
	switch family {
	case 141:
		return chipMeta{"GFX900", "Vega10", "gfx900", "GC 9.0.0"}
	case 142:
		return chipMeta{"GFX902", "Raven", "gfx902", "GC 9.1.0"}
	case 143:
		return chipMeta{"GFX1010", "Navi10", "gfx1010", "GC 10.1.0"}
	case 144:
		return chipMeta{"GFX1033", "Van Gogh", "gfx1033", "GC 10.3.3"}
	case 145:
		return chipMeta{"GFX1100", "Navi31", "gfx1100", "GC 11.0.0"}
	case 146:
		return chipMeta{"GFX1035", "Yellow Carp", "gfx1035", "GC 10.3.5"}
	case 148:
		return chipMeta{"GFX1103", "Phoenix", "gfx1103", "GC 11.0.1"}
	case 149:
		return chipMeta{"GFX1036", "Raphael/Mendocino", "gfx1036", "GC 10.3.6"}
	case 150:
		return chipMeta{"GFX1151", "Strix Halo", "gfx1151", "GC 11.5.0"}
	case 151:
		return chipMeta{"GFX1037", "GC 10.3.7", "gfx1037", "GC 10.3.7"}
	case 152:
		return chipMeta{"GFX1200", "Navi48", "gfx1200", "GC 12.0.0"}
	case 154:
		return chipMeta{"GFX1154", "GC 11.5.4", "gfx1154", "GC 11.5.4"}
	default:
		return chipMeta{
			fmt.Sprintf("GFX?%d", family),
			fmt.Sprintf("Unknown (family %d)", family),
			fmt.Sprintf("gfxunknown%d", family),
			"",
		}
	}
}

// ── sysfs helpers ──────────────────────────────────────────────────────────────

func readSysfsString(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readSysfsUint64(path string) (uint64, bool) {
	s := readSysfsString(path)
	if s == "" {
		return 0, false
	}
	// strip leading "0x" for hex values
	base := 10
	if strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X") {
		s = s[2:]
		base = 16
	}
	v, err := strconv.ParseUint(s, base, 64)
	return v, err == nil
}

func readSysfsFloat(path string) (float64, bool) {
	s := readSysfsString(path)
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

func renderDevPath(card int) string {
	return fmt.Sprintf("/sys/class/drm/renderD%d/device", 128+card)
}

// ── per-device sysfs info ─────────────────────────────────────────────────────

func readVRAMType(card int) string {
	return readSysfsString(filepath.Join(renderDevPath(card), "mem_info_vram_type"))
}

func readVRAMVendor(card int) string {
	v := readSysfsString(filepath.Join(renderDevPath(card), "mem_info_vram_vendor"))
	if v == "" || v == "0" {
		return ""
	}
	return v
}

func readPCIDeviceID(card int) (devID uint16, revID uint8) {
	base := renderDevPath(card)
	if v, ok := readSysfsUint64(filepath.Join(base, "device")); ok {
		devID = uint16(v)
	}
	if v, ok := readSysfsUint64(filepath.Join(base, "revision")); ok {
		revID = uint8(v)
	}
	return
}

// readGPUActivityPct returns GFX, Memory, MediaEngine activity percentages from sysfs.
// These fallback sources are used when GRBM sampling is unavailable (noPC) or for
// Memory/VCN which GRBM doesn't cover.
func readGPUActivityPct(card int) (gpuPct, memPct, vcnPct float64, hasGPU, hasMem, hasVCN bool) {
	base := renderDevPath(card)
	gpuPct, hasGPU = readSysfsFloat(filepath.Join(base, "gpu_busy_percent"))
	memPct, hasMem = readSysfsFloat(filepath.Join(base, "mem_busy_percent"))
	vcnPct, hasVCN = readSysfsFloat(filepath.Join(base, "vcn_busy_percent"))
	return
}

// ── CPU core frequencies ──────────────────────────────────────────────────────

type cpuCoreFreq struct {
	ThreadID int `json:"thread_id"`
	CoreID   int `json:"core_id"`
	CurFreq  int `json:"cur_freq"` // MHz
	MinFreq  int `json:"min_freq"`
	MaxFreq  int `json:"max_freq"`
}

func readCPUCoreFreq() []cpuCoreFreq {
	cpuDirs, _ := filepath.Glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq")
	var result []cpuCoreFreq
	for _, dir := range cpuDirs {
		cpuDir := filepath.Dir(dir)
		threadID, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(cpuDir), "cpu"))
		if err != nil {
			continue
		}
		curKHz, ok1 := readSysfsUint64(filepath.Join(dir, "scaling_cur_freq"))
		maxKHz, ok2 := readSysfsUint64(filepath.Join(dir, "scaling_max_freq"))
		if !ok1 || !ok2 {
			continue
		}
		minKHz, _ := readSysfsUint64(filepath.Join(dir, "scaling_min_freq"))
		coreID, _ := readSysfsUint64(filepath.Join(cpuDir, "topology", "core_id"))
		result = append(result, cpuCoreFreq{
			ThreadID: threadID,
			CoreID:   int(coreID),
			CurFreq:  int(curKHz / 1000),
			MinFreq:  int(minKHz / 1000),
			MaxFreq:  int(maxKHz / 1000),
		})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ThreadID < result[j].ThreadID })
	return result
}

// ── device Info map ────────────────────────────────────────────────────────────

// buildDeviceInfoMap constructs the Info object for a GPU device from all
// available sources: DRM ioctl results, sysfs, and derived values.
func buildDeviceInfoMap(
	card int,
	di *amdgpu.DeviceInfo,
	mi *amdgpu.MemoryInfo,
	pciDev string,
	drmVersion string,
) map[string]interface{} {
	meta := chipMetaForFamily(di.Family)

	gpuType := "Discrete"
	if di.IsApu {
		gpuType = "APU"
	}

	devID, _ := readPCIDeviceID(card)
	vramType := readVRAMType(card)
	vramVendor := readVRAMVendor(card)

	var drmMajor, drmMinor, drmPatch int
	fmt.Sscanf(drmVersion, "%d.%d.%d", &drmMajor, &drmMinor, &drmPatch)

	m := map[string]interface{}{
		"DeviceName":         readGPUName(card),
		"ASIC Name":          meta.ChipClass + "/" + meta.Name,
		"Chip Class":         meta.ChipClass,
		"DeviceID":           int(devID),
		"RevisionID":         int(di.ExternalRev),
		"PCI":                pciDev,
		"GPU Family":         meta.GPUFamily,
		"GPU Type":           gpuType,
		"gfx_target_version": meta.GFXTarget,
		"GPU Clock": map[string]interface{}{
			"max": int(di.MaxEngineClock / 1000),
			"min": 0,
		},
		"Memory Clock": map[string]interface{}{
			"max": int(di.MaxMemoryClock / 1000),
			"min": 0,
		},
		"VRAM Size":       int64(mi.VRAMTotalHeapSize),
		"VRAM Usage Size": int64(mi.VRAMHeapUsage),
		"GTT Size":        int64(mi.GTTTotalHeapSize),
		"GTT Usage Size":  int64(mi.GTTHeapUsage),
		"ResizableBAR":    mi.ResizableBar,
		"drm_version": map[string]interface{}{
			"major":      drmMajor,
			"minor":      drmMinor,
			"patchlevel": drmPatch,
		},
		"num_tcc_blocks": int(di.NUMTCCBlocks),
	}

	if di.GL0CacheSize > 0 {
		m["GL0 Cache Size"] = int64(di.GL0CacheSize)
	}
	if di.GL1CacheSize > 0 {
		m["GL1 Cache Size"] = int64(di.GL1CacheSize)
	}
	if di.GL2CacheSize > 0 {
		m["GL2 Cache Size"] = int64(di.GL2CacheSize)
	}
	if di.MallSize > 0 {
		m["L3 Cache Size"] = int64(di.MallSize)
	}
	if vramType != "" {
		m["VRAM Type"] = vramType
	}
	if vramVendor != "" {
		m["VRAM Vendor"] = vramVendor
	}

	return m
}

// ── Total fdinfo aggregation ──────────────────────────────────────────────────

// computeTotalFdinfo sums all per-process fdinfo engine usage and memory into
// a single "Total fdinfo" map matching amdgpu_top's format.
func computeTotalFdinfo(perProc map[string]interface{}) map[string]interface{} {
	totals := map[string]float64{}
	for _, procRaw := range perProc {
		proc, ok := procRaw.(map[string]interface{})
		if !ok {
			continue
		}
		usage, ok := proc["usage"].(map[string]interface{})
		if !ok {
			continue
		}
		for k, v := range usage {
			switch val := v.(type) {
			case float64:
				totals[k] += val
			}
		}
	}

	out := make(map[string]interface{}, len(totals))
	for k, v := range totals {
		out[k] = v
	}
	return out
}
