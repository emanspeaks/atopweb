//go:build linux && cgo

// probe is a standalone diagnostic tool for testing amdgpu-go hardware reads
// and the DRM sensor/metrics/fdinfo parsing without running the full atopweb
// server.  Run it from the dev shell:
//
//	nix develop
//	go run ./cmd/probe          # or: sudo go run ./cmd/probe
//	go run ./cmd/probe -card 1  # second GPU
//
// Useful flags:
//
//	-card N      GPU card index (default 0 → /dev/dri/renderD128)
//	-grbm        Sample GRBM/GRBM2 registers for ~1 s and print percentages
//	-metrics     Dump parsed gpu_metrics blob
//	-sensors     Dump hwmon sensor values and pp_dpm clocks
//	-fdinfo      Dump per-process fdinfo usage
//	-loop N      Repeat all enabled probes N times with 1s sleep between
package main

import (
	"encoding/binary"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	amdgpu "github.com/emanspeaks/amdgpu-go"
)

func main() {
	card := flag.Int("card", 0, "GPU card index (0 → renderD128)")
	doGRBM := flag.Bool("grbm", false, "sample GRBM/GRBM2 registers for ~1 s")
	doMetrics := flag.Bool("metrics", false, "dump parsed gpu_metrics blob")
	doSensors := flag.Bool("sensors", false, "dump hwmon sensors and pp_dpm clocks")
	doFdinfo := flag.Bool("fdinfo", false, "dump per-process fdinfo GPU usage")
	doAll := flag.Bool("all", false, "enable all probes")
	loop := flag.Int("loop", 1, "repeat all probes N times (0 = forever)")
	verbose := flag.Bool("v", false, "verbose: print fdinfo scan details")
	flag.Parse()

	if *doAll {
		*doGRBM, *doMetrics, *doSensors, *doFdinfo = true, true, true, true
	}
	// default: show everything if no flag given
	if !*doGRBM && !*doMetrics && !*doSensors && !*doFdinfo {
		*doGRBM, *doMetrics, *doSensors, *doFdinfo = true, true, true, true
	}

	dev, err := amdgpu.Open(*card)
	if err != nil {
		fmt.Fprintf(os.Stderr, "open card%d: %v\n", *card, err)
		os.Exit(1)
	}
	defer dev.Close()

	fmt.Printf("=== card%d (renderD%d) ===\n", *card, 128+*card)

	// Device info — always shown
	info, err := dev.DeviceInfo()
	if err != nil {
		fmt.Printf("DeviceInfo: error: %v\n", err)
	} else {
		fmt.Printf("DeviceInfo:\n")
		fmt.Printf("  Family:         %d\n", info.Family)
		fmt.Printf("  ExternalRev:    %d\n", info.ExternalRev)
		fmt.Printf("  IsAPU:          %v\n", info.IsApu)
		fmt.Printf("  MaxEngineClock: %d kHz (%.0f MHz)\n", info.MaxEngineClock, float64(info.MaxEngineClock)/1000)
		fmt.Printf("  MaxMemClock:    %d kHz (%.0f MHz)\n", info.MaxMemoryClock, float64(info.MaxMemoryClock)/1000)
	}

	mem, err := dev.MemoryInfo()
	if err != nil {
		fmt.Printf("MemoryInfo: error: %v\n", err)
	} else {
		const mib = 1 << 20
		fmt.Printf("MemoryInfo:\n")
		fmt.Printf("  VRAM used/total: %.1f / %.1f MiB\n",
			float64(mem.VRAMHeapUsage)/mib, float64(mem.VRAMTotalHeapSize)/mib)
		fmt.Printf("  GTT  used/total: %.1f / %.1f MiB\n",
			float64(mem.GTTHeapUsage)/mib, float64(mem.GTTTotalHeapSize)/mib)
		fmt.Printf("  ReBAR:           %v\n", mem.ResizableBar)
	}

	drmVer, err := dev.DRMVersion()
	if err == nil {
		fmt.Printf("DRM driver:  %s %s (%s)\n", drmVer.Name, drmVer.Version, drmVer.Date)
	}

	for iter := 0; *loop == 0 || iter < *loop; iter++ {
		if iter > 0 {
			time.Sleep(time.Second)
			fmt.Println()
		}

		if *doGRBM {
			probeGRBM(dev)
		}
		if *doMetrics {
			probeMetrics(*card)
		}
		if *doSensors {
			probeSensors(*card)
		}
		if *doFdinfo {
			probeFdinfo(*card, *verbose)
		}
	}
}

// ── GRBM/GRBM2 register sampling ─────────────────────────────────────────────

func probeGRBM(dev *amdgpu.Device) {
	const samples = 64
	var grbm, grbm2 [32]int

	fmt.Printf("\n--- GRBM/GRBM2 (%d samples over ~1s) ---\n", samples)
	sleepPer := time.Second / samples
	for i := 0; i < samples; i++ {
		if v, err := dev.ReadGRBM(); err == nil {
			for b := uint(0); b < 32; b++ {
				if v&(1<<b) != 0 {
					grbm[b]++
				}
			}
		} else {
			fmt.Printf("  ReadGRBM error: %v\n", err)
			break
		}
		if v, err := dev.ReadGRBM2(); err == nil {
			for b := uint(0); b < 32; b++ {
				if v&(1<<b) != 0 {
					grbm2[b]++
				}
			}
		} else {
			fmt.Printf("  ReadGRBM2 error: %v\n", err)
		}
		time.Sleep(sleepPer)
	}

	// Print one raw sample so we can check register presence
	raw, _ := dev.ReadGRBM()
	raw2, _ := dev.ReadGRBM2()
	fmt.Printf("  GRBM  raw: 0x%08X\n", raw)
	fmt.Printf("  GRBM2 raw: 0x%08X\n", raw2)

	fmt.Printf("  GRBM  non-zero bits: ")
	for b := uint(0); b < 32; b++ {
		if grbm[b] > 0 {
			fmt.Printf("bit%d=%.0f%% ", b, float64(grbm[b])/samples*100)
		}
	}
	fmt.Println()
	fmt.Printf("  GRBM2 non-zero bits: ")
	for b := uint(0); b < 32; b++ {
		if grbm2[b] > 0 {
			fmt.Printf("bit%d=%.0f%% ", b, float64(grbm2[b])/samples*100)
		}
	}
	fmt.Println()
}

// ── gpu_metrics binary dump ───────────────────────────────────────────────────

func probeMetrics(card int) {
	path := fmt.Sprintf("/sys/class/drm/renderD%d/device/gpu_metrics", 128+card)
	data, err := os.ReadFile(path)
	if err != nil {
		fmt.Printf("\n--- gpu_metrics: unavailable (%v) ---\n", err)
		return
	}
	if len(data) < 4 {
		fmt.Printf("\n--- gpu_metrics: too short (%d bytes) ---\n", len(data))
		return
	}
	structSize := int(binary.LittleEndian.Uint16(data[0:2]))
	formatRev := data[2]
	contentRev := data[3]
	fmt.Printf("\n--- gpu_metrics (format=%d content=%d size=%d blob=%d bytes) ---\n",
		formatRev, contentRev, structSize, len(data))

	// Print first 200 bytes as hex+ascii
	dump := data
	if len(dump) > 200 {
		dump = dump[:200]
	}
	for i, b := range dump {
		if i%16 == 0 {
			fmt.Printf("  %04x: ", i)
		}
		fmt.Printf("%02x ", b)
		if i%16 == 15 || i == len(dump)-1 {
			// ascii
			pad := 15 - (i % 16)
			for p := 0; p < pad; p++ {
				fmt.Print("   ")
			}
			start := (i / 16) * 16
			for _, c := range dump[start : i+1] {
				if c >= 32 && c < 127 {
					fmt.Printf("%c", c)
				} else {
					fmt.Print(".")
				}
			}
			fmt.Println()
		}
	}

	// Interpret key fields based on format version
	rd16 := func(off int) uint16 {
		if off+2 > len(data) {
			return 0
		}
		return binary.LittleEndian.Uint16(data[off:])
	}
	rd32 := func(off int) uint32 {
		if off+4 > len(data) {
			return 0
		}
		return binary.LittleEndian.Uint32(data[off:])
	}

	switch formatRev {
	case 2:
		fmt.Printf("  temperature_gfx:         %d (%.2f °C)\n", rd16(4), float64(rd16(4))/100)
		fmt.Printf("  temperature_soc:         %d (%.2f °C)\n", rd16(6), float64(rd16(6))/100)
		fmt.Printf("  average_socket_power:    %d mW (%.2f W)\n", rd16(40), float64(rd16(40))/1000)
		fmt.Printf("  average_cpu_power:       %d mW (%.2f W)\n", rd16(42), float64(rd16(42))/1000)
		fmt.Printf("  average_gfx_power:       %d mW (%.2f W)\n", rd16(46), float64(rd16(46))/1000)
		fmt.Printf("  average_core_power[0..7]:")
		for j := 0; j < 8; j++ {
			fmt.Printf(" %d", rd16(48+j*2))
		}
		fmt.Println(" mW")
		fmt.Printf("  average_gfxclk_freq:     %d MHz\n", rd16(64))
		fmt.Printf("  average_socclk_freq:     %d MHz\n", rd16(66))
		fmt.Printf("  average_fclk_freq:       %d MHz\n", rd16(70))
		fmt.Printf("  average_vclk_freq:       %d MHz\n", rd16(72))
		fmt.Printf("  current_coreclk[0..7]:  ")
		for j := 0; j < 8; j++ {
			fmt.Printf(" %d", rd16(88+j*2))
		}
		fmt.Println(" MHz")
	case 3:
		fmt.Printf("  temperature_gfx:         %d (%.2f °C)\n", rd16(4), float64(rd16(4))/100)
		fmt.Printf("  temperature_soc:         %d (%.2f °C)\n", rd16(6), float64(rd16(6))/100)
		fmt.Printf("  average_socket_power:    %d mW (%.2f W)\n", rd32(112), float64(rd32(112))/1000)
		fmt.Printf("  average_ipu_power:       %d mW (%.2f W)\n", rd16(116), float64(rd16(116))/1000)
		fmt.Printf("  average_all_core_power:  %d mW (%.2f W)\n", rd32(132), float64(rd32(132))/1000)
		fmt.Printf("  average_fclk_freq:       %d MHz\n", rd16(182))
		fmt.Printf("  average_vclk_freq:       %d MHz\n", rd16(184))
	case 1:
		if contentRev >= 1 {
			fmt.Printf("  temperature_edge:        %d (%.2f °C)\n", rd16(4), float64(rd16(4))/100)
			fmt.Printf("  temperature_hotspot:     %d (%.2f °C)\n", rd16(6), float64(rd16(6))/100)
			fmt.Printf("  temperature_mem:         %d (%.2f °C)\n", rd16(8), float64(rd16(8))/100)
			fmt.Printf("  average_socket_power:    %d mW\n", rd16(22))
			fmt.Printf("  average_gfxclk_freq:     %d MHz\n", rd16(40))
		}
	default:
		fmt.Printf("  (unknown format_revision=%d — raw hex above)\n", formatRev)
	}
}

// ── hwmon sensors and pp_dpm clocks ──────────────────────────────────────────

func probeSensors(card int) {
	fmt.Printf("\n--- hwmon sensors ---\n")

	dirs, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, dir := range dirs {
		chip := strings.TrimSpace(readFile(filepath.Join(dir, "name")))
		inputs, _ := filepath.Glob(filepath.Join(dir, "*_input"))
		for _, inp := range inputs {
			prefix := strings.TrimSuffix(filepath.Base(inp), "_input")
			label := strings.TrimSpace(readFile(filepath.Join(dir, prefix+"_label")))
			if label == "" {
				label = prefix
			}
			val := strings.TrimSpace(readFile(inp))
			fmt.Printf("  %-12s %-20s = %s\n", chip, label, val)
		}
	}

	fmt.Printf("\n--- pp_dpm clocks (card%d / renderD%d) ---\n", card, 128+card)
	base := fmt.Sprintf("/sys/class/drm/renderD%d/device", 128+card)
	for _, name := range []string{"pp_dpm_sclk", "pp_dpm_mclk", "pp_dpm_fclk", "pp_dpm_socclk"} {
		data := readFile(filepath.Join(base, name))
		if data == "" {
			continue
		}
		fmt.Printf("  %s:\n", name)
		for _, line := range strings.Split(strings.TrimSpace(data), "\n") {
			fmt.Printf("    %s\n", line)
		}
	}
}

// ── fdinfo per-process ────────────────────────────────────────────────────────

func probeFdinfo(card int, verbose bool) {
	pciDev := pciDevFromCard(card)
	fmt.Printf("\n--- fdinfo (card%d pci=%s) ---\n", card, pciDev)

	procDirs, _ := filepath.Glob("/proc/[0-9]*/fdinfo")
	if verbose {
		fmt.Printf("  scanning %d process fdinfo dirs\n", len(procDirs))
	}
	found := 0
	for _, fdinfoDir := range procDirs {
		pidStr := filepath.Base(filepath.Dir(fdinfoDir))
		pid, _ := strconv.Atoi(pidStr)
		fds, _ := filepath.Glob(filepath.Join(fdinfoDir, "*"))
		for _, fd := range fds {
			content, err := os.ReadFile(fd)
			if err != nil {
				if verbose {
					fmt.Printf("  pid %d fd %s: read error: %v\n", pid, filepath.Base(fd), err)
				}
				continue
			}
			// fdinfo uses "key:\tvalue" separator; normalise tabs to spaces
			s := strings.ReplaceAll(string(content), ":\t", ": ")
			if !strings.Contains(s, "drm-driver: amdgpu") {
				continue
			}
			if verbose {
				fmt.Printf("  pid %d fd %s: drm-driver match; pciDev check=%q\n", pid, filepath.Base(fd), pciDev)
			}
			if pciDev != "" && !strings.Contains(s, "drm-pdev: "+pciDev) {
				if verbose {
					// print the pdev line so we can see what it actually says
					for _, line := range strings.Split(s, "\n") {
						if strings.HasPrefix(line, "drm-pdev") {
							fmt.Printf("    pdev mismatch: %q\n", line)
						}
					}
				}
				continue
			}
			name := strings.TrimSpace(readFile(fmt.Sprintf("/proc/%d/comm", pid)))
			fmt.Printf("  pid %d (%s):\n", pid, name)
			for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
				k := strings.SplitN(line, ":", 2)[0]
				if strings.HasPrefix(k, "drm-engine-") || strings.HasPrefix(k, "drm-memory-") || strings.HasPrefix(k, "drm-driver") || strings.HasPrefix(k, "drm-pdev") {
					fmt.Printf("    %s\n", line)
				}
			}
			found++
			break // one fd per pid is enough to show
		}
	}
	if found == 0 {
		fmt.Printf("  (no amdgpu fds found — try running as root for other users' processes)\n")
	}
}

// ── helpers ───────────────────────────────────────────────────────────────────

func readFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

func pciDevFromCard(card int) string {
	dev, err := filepath.EvalSymlinks(fmt.Sprintf("/sys/class/drm/renderD%d/device", 128+card))
	if err != nil {
		return ""
	}
	return filepath.Base(dev)
}
