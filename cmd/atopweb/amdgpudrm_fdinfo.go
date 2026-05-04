//go:build linux && cgo

package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// fdinfoProcSnapshot holds a single poll-cycle snapshot of per-process GPU stats
// read from /proc/PID/fdinfo/FD for amdgpu fds.
type fdinfoProcSnapshot struct {
	Name      string
	EngineNS  map[string]uint64 // accumulated engine nanoseconds per engine name
	MemBytes  map[string]uint64 // memory bytes per type (vram, gtt, cpu)
	Timestamp time.Time
}

// pciDevForCard returns the PCI device address for a GPU render node (e.g. "0000:c2:00.0").
// The sysfs "device" symlink under a DRM node uses a relative target (e.g. "../.."),
// so we EvalSymlinks to get the absolute path before taking Base.
func pciDevForCard(card int) string {
	dev, err := filepath.EvalSymlinks(fmt.Sprintf("/sys/class/drm/renderD%d/device", 128+card))
	if err != nil {
		return ""
	}
	return filepath.Base(dev)
}

// scanDRMFdinfo scans /proc/*/fdinfo/* for file descriptors belonging to the
// given amdgpu PCI device and returns a snapshot per PID.
func scanDRMFdinfo(pciDev string) map[int]fdinfoProcSnapshot {
	now := time.Now()
	result := make(map[int]fdinfoProcSnapshot)

	procDirs, _ := filepath.Glob("/proc/[0-9]*/fdinfo")
	for _, fdinfoDir := range procDirs {
		// Extract PID from path (/proc/PID/fdinfo)
		pidStr := filepath.Base(filepath.Dir(fdinfoDir))
		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}

		fds, _ := filepath.Glob(filepath.Join(fdinfoDir, "*"))
		var snap *fdinfoProcSnapshot
		for _, fd := range fds {
			entry := parseFdinfoEntry(fd, pciDev)
			if entry == nil {
				continue
			}
			if snap == nil {
				name := readProcName(pid)
				snap = &fdinfoProcSnapshot{
					Name:      name,
					EngineNS:  make(map[string]uint64),
					MemBytes:  make(map[string]uint64),
					Timestamp: now,
				}
				result[pid] = *snap
			}
			// Accumulate across multiple fds for the same PID
			existing := result[pid]
			for k, v := range entry.EngineNS {
				existing.EngineNS[k] += v
			}
			for k, v := range entry.MemBytes {
				if v > existing.MemBytes[k] {
					existing.MemBytes[k] = v // take max across fds (not sum)
				}
			}
			result[pid] = existing
		}
	}
	return result
}

// parseFdinfoEntry reads a single fdinfo file and returns engine+memory stats
// if it belongs to an amdgpu fd on the given PCI device. Returns nil otherwise.
func parseFdinfoEntry(path, wantPCIDev string) *fdinfoProcSnapshot {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	snap := &fdinfoProcSnapshot{
		EngineNS: make(map[string]uint64),
		MemBytes: make(map[string]uint64),
	}
	isAMDGPU := false
	pciMatch := wantPCIDev == "" // if no device filter, accept any amdgpu fd

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		colon := strings.IndexByte(line, ':')
		if colon < 0 {
			continue
		}
		key := strings.TrimSpace(line[:colon])
		val := strings.TrimSpace(line[colon+1:])

		switch {
		case key == "drm-driver":
			if val != "amdgpu" {
				return nil
			}
			isAMDGPU = true
		case key == "drm-pdev":
			if wantPCIDev != "" && val == wantPCIDev {
				pciMatch = true
			}
		case strings.HasPrefix(key, "drm-engine-"):
			engine := engineKey(strings.TrimPrefix(key, "drm-engine-"))
			// value is "<ns> ns"
			if ns, ok := parseNS(val); ok {
				snap.EngineNS[engine] = ns
			}
		case strings.HasPrefix(key, "drm-memory-"):
			mem := strings.TrimPrefix(key, "drm-memory-")
			// value is "<n> B" or "<n> KiB" depending on kernel version
			if b, ok := parseBytes(val); ok {
				snap.MemBytes[mem] = b
			}
		}
	}

	if !isAMDGPU || !pciMatch {
		return nil
	}
	return snap
}

// engineKey normalises an fdinfo drm-engine-* suffix to the frontend's
// expected key name.  Engine names from amdgpu_fdinfo.c in the Linux kernel.
func engineKey(raw string) string {
	switch raw {
	case "gfx":
		return "GFX"
	case "compute":
		return "Compute"
	case "dma":
		return "DMA"
	case "dec":
		return "Decode"
	case "enc":
		return "Media"
	case "enc_1":
		return "Media1"
	case "jpeg":
		return "VCN_JPEG"
	case "vpe":
		return "VPE"
	default:
		return raw
	}
}

// parseNS parses a string like "1234567 ns" and returns the integer nanoseconds.
func parseNS(s string) (uint64, bool) {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0, false
	}
	v, err := strconv.ParseUint(fields[0], 10, 64)
	return v, err == nil
}

// parseBytes parses a string like "1048576 B", "12 KiB", "2 MiB" and returns bytes.
// The kernel's amdgpu driver uses KiB units on newer kernels.
func parseBytes(s string) (uint64, bool) {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return 0, false
	}
	v, err := strconv.ParseUint(fields[0], 10, 64)
	if err != nil {
		return 0, false
	}
	if len(fields) >= 2 {
		switch strings.ToUpper(fields[1]) {
		case "KIB", "KB":
			v *= 1024
		case "MIB", "MB":
			v *= 1024 * 1024
		case "GIB", "GB":
			v *= 1024 * 1024 * 1024
		}
	}
	return v, true
}

// computeFdinfoDeltas computes per-process GPU engine usage percentages by
// comparing the current snapshot against the previous one.
// dt is the elapsed time in seconds between snapshots.
// Returns a map keyed by PID string suitable for JSON marshalling as fdinfo.
func computeFdinfoDeltas(
	prev map[int]fdinfoProcSnapshot,
	curr map[int]fdinfoProcSnapshot,
	dt float64,
) map[string]interface{} {
	out := make(map[string]interface{})
	if dt <= 0 {
		return out
	}
	const nsPerSec = 1e9
	dtNS := dt * nsPerSec

	for pid, cs := range curr {
		usage := make(map[string]interface{})

		ps, hasPrev := prev[pid]
		for eng, curNS := range cs.EngineNS {
			var pct float64
			if hasPrev {
				if prevNS, ok := ps.EngineNS[eng]; ok && curNS >= prevNS {
					pct = float64(curNS-prevNS) / dtNS * 100
					if pct > 100 {
						pct = 100
					}
				}
			}
			usage[eng] = pct
		}

		// Memory: report in MiB
		if vram, ok := cs.MemBytes["vram"]; ok {
			usage["VRAM"] = float64(vram) / (1 << 20)
		}
		if gtt, ok := cs.MemBytes["gtt"]; ok {
			usage["GTT"] = float64(gtt) / (1 << 20)
		}

		if len(usage) == 0 {
			continue
		}
		out[strconv.Itoa(pid)] = map[string]interface{}{
			"name":  cs.Name,
			"usage": usage,
		}
	}
	return out
}
