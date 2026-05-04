package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// dmidecodeBins lists absolute paths to try when dmidecode is not in PATH.
var dmidecodeBins = []string{
	"/sbin/dmidecode",
	"/usr/sbin/dmidecode",
	"/usr/bin/dmidecode",
	"/bin/dmidecode",
	"/run/current-system/sw/bin/dmidecode",
}

// readCPUGovernor returns the scaling governor of cpu0 — e.g. "performance",
// "powersave", "schedutil", "ondemand". Empty when cpufreq isn't exposed
// (virtualized hosts, non-Linux). cpu0 is representative because Linux
// applies the same governor to every core by default; heterogeneous configs
// would need per-core reporting.
func readCPUGovernor() string {
	return readFileTrim("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
}

// readKernelVersion returns the running kernel release string, e.g.
// "6.6.63-nixos". Empty on non-Linux or when /proc is unavailable.
func readKernelVersion() string {
	return strings.TrimSpace(string(mustReadFileOrEmpty("/proc/sys/kernel/osrelease")))
}

// readOsRelease parses /etc/os-release and returns key/value pairs with
// shell-style quotes stripped.
func readOsRelease() map[string]string {
	m := map[string]string{}
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(b), "\n") {
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		k := line[:eq]
		v := strings.Trim(line[eq+1:], `"`)
		m[k] = v
	}
	return m
}

// readNixosInfo returns ("25.05", 42) on NixOS, or ("", 0) elsewhere.
// Generation comes from the target of /nix/var/nix/profiles/system, which is
// set to "system-<N>-link" after every `nixos-rebuild switch` / `boot`.
func readNixosInfo() (version string, generation int) {
	osr := readOsRelease()
	if osr["ID"] != "nixos" {
		return "", 0
	}
	version = osr["VERSION_ID"]
	if version == "" {
		version = osr["VERSION"]
	}
	if target, err := os.Readlink("/nix/var/nix/profiles/system"); err == nil {
		name := strings.TrimPrefix(strings.TrimSuffix(target, "-link"), "system-")
		if n, err := strconv.Atoi(name); err == nil {
			generation = n
		}
	}
	return version, generation
}

// readDRAMMaxBWKiBs parses dmidecode --type 17 to calculate the theoretical
// peak DRAM bandwidth: Σ (data_width_bytes × configured_speed_MT_s × 1e6) / 1024.
// Returns 0 and logs if dmidecode is unavailable or the output can't be parsed.
func readDRAMMaxBWKiBs() uint64 {
	bin, _ := exec.LookPath("dmidecode")
	if bin == "" {
		for _, p := range dmidecodeBins {
			if _, err := os.Stat(p); err == nil {
				bin = p
				break
			}
		}
	}
	if bin == "" {
		log.Printf("atopweb: dmidecode not found — DRAM bandwidth ceiling unavailable")
		return 0
	}

	out, err := exec.Command(bin, "--type", "17").Output()
	if err != nil {
		log.Printf("atopweb: dmidecode --type 17: %v", err)
		return 0
	}

	var totalBps uint64
	var dataWidthBits, speedMTs int
	var populated bool

	flush := func() {
		if populated && dataWidthBits > 0 && speedMTs > 0 {
			totalBps += uint64(dataWidthBits/8) * uint64(speedMTs) * 1_000_000
		}
		dataWidthBits, speedMTs, populated = 0, 0, false
	}

	for _, raw := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == "Memory Device":
			flush()
		case strings.HasPrefix(line, "Data Width:"):
			var bits int
			if _, err := fmt.Sscanf(strings.TrimPrefix(line, "Data Width:"), "%d", &bits); err == nil && bits > 0 {
				dataWidthBits = bits
			}
		case strings.HasPrefix(line, "Configured Memory Speed:"):
			var speed int
			if _, err := fmt.Sscanf(strings.TrimPrefix(line, "Configured Memory Speed:"), "%d", &speed); err == nil && speed > 0 {
				speedMTs = speed
			}
		case strings.HasPrefix(line, "Size:"):
			s := strings.TrimSpace(strings.TrimPrefix(line, "Size:"))
			if s != "" && s != "No Module Installed" && s != "Not Installed" && s != "Not Present" && !strings.HasPrefix(s, "0 ") {
				populated = true
			}
		}
	}
	flush()

	if totalBps == 0 {
		log.Printf("atopweb: could not parse DRAM bandwidth ceiling from dmidecode output")
		return 0
	}
	kiBs := totalBps / 1024
	log.Printf("atopweb: DRAM theoretical max: %d KiB/s (%d GB/s)", kiBs, totalBps/1_000_000_000)
	return kiBs
}
