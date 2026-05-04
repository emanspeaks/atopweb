//go:build linux && cgo

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// hwmonDirForCard finds the hwmon sysfs directory for the given GPU card index
// by resolving device symlinks to the underlying PCI device path.
// Uses the render node path (renderD128+card) which is more reliable than
// card%d when card indices don't match render node indices.
func hwmonDirForCard(card int) string {
	cardDev := fmt.Sprintf("/sys/class/drm/renderD%d/device", 128+card)
	realCard, err := filepath.EvalSymlinks(cardDev)
	if err != nil {
		return ""
	}
	dirs, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, dir := range dirs {
		realHwmon, err := filepath.EvalSymlinks(filepath.Join(dir, "device"))
		if err != nil {
			continue
		}
		if realCard == realHwmon {
			return dir
		}
	}
	return ""
}

// findHwmonSensor searches a hwmon directory for a sensor of the given kind
// (e.g. "temp", "power", "in") whose label matches the given string.
// Returns the raw file value and true on success.
func findHwmonSensor(dir, kind, label string) (float64, bool) {
	inputs, _ := filepath.Glob(filepath.Join(dir, kind+"*_input"))
	for _, input := range inputs {
		prefix := strings.TrimSuffix(filepath.Base(input), "_input")
		lbl := strings.TrimSpace(readFileTrim(filepath.Join(dir, prefix+"_label")))
		if strings.EqualFold(lbl, label) {
			raw := strings.TrimSpace(readFileTrim(input))
			val, err := strconv.ParseFloat(raw, 64)
			if err == nil {
				return val, true
			}
		}
	}
	return 0, false
}

// readCPUTctl returns the k10temp "Tctl" temperature in °C (true if found).
func readCPUTctl() (float64, bool) {
	dirs, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, dir := range dirs {
		if strings.TrimSpace(readFileTrim(filepath.Join(dir, "name"))) != "k10temp" {
			continue
		}
		if v, ok := findHwmonSensor(dir, "temp", "Tctl"); ok {
			return v / 1000, true // milli-°C → °C
		}
	}
	return 0, false
}

// readCurrentClockMHz parses a pp_dpm_* sysfs file and returns the active
// clock frequency in MHz. Lines look like "0: 300MHz *"; the current
// active state is marked with " *".
func readCurrentClockMHz(path string) float64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.Contains(line, "*") {
			continue
		}
		for _, field := range strings.Fields(line) {
			lower := strings.ToLower(field)
			if strings.HasSuffix(lower, "mhz") {
				val, err := strconv.ParseFloat(strings.TrimSuffix(lower, "mhz"), 64)
				if err == nil {
					return val
				}
			}
		}
	}
	return 0
}

// readDRMSensors builds the Sensors map for a GPU card from hwmon and sysfs.
// cpuTctl is the k10temp "Tctl" value (°C); hasCPUTctl indicates if it was found.
func readDRMSensors(card int, cpuTctl float64, hasCPUTctl bool) map[string]float64 {
	s := make(map[string]float64)

	if dir := hwmonDirForCard(card); dir != "" {
		// Edge die temperature — hwmon reports milli-°C
		if v, ok := findHwmonSensor(dir, "temp", "edge"); ok {
			s["Edge Temperature"] = v / 1000
		}
		// PPT power in microwatts → watts
		if v, ok := findHwmonSensor(dir, "power", "PPT"); ok {
			s["Average Power"] = v / 1_000_000
		}
		// Voltages — hwmon in* values are already in millivolts
		if v, ok := findHwmonSensor(dir, "in", "vddgfx"); ok {
			s["VDDGFX"] = v
		}
		if v, ok := findHwmonSensor(dir, "in", "vddnb"); ok {
			s["VDDNB"] = v
		}
	}

	if hasCPUTctl {
		s["CPU Tctl"] = cpuTctl
	}

	// GPU clocks from sysfs pp_dpm_* tables; fall back to hwmon freq*_input
	// on newer APUs (GFX12+) that don't expose pp_dpm_* nodes.
	// Use the render node path so card index mismatches (card0 ≠ renderD128)
	// don't send us to the wrong device directory.
	base := fmt.Sprintf("/sys/class/drm/renderD%d/device", 128+card)
	if clk := readCurrentClockMHz(filepath.Join(base, "pp_dpm_sclk")); clk > 0 {
		s["GFX_SCLK"] = clk
	} else if dir := hwmonDirForCard(card); dir != "" {
		// hwmon freq*_input reports Hz; convert to MHz
		if v, ok := findHwmonSensor(dir, "freq", "sclk"); ok && v > 0 {
			s["GFX_SCLK"] = v / 1e6
		}
	}
	if clk := readCurrentClockMHz(filepath.Join(base, "pp_dpm_mclk")); clk > 0 {
		s["GFX_MCLK"] = clk
	} else if dir := hwmonDirForCard(card); dir != "" {
		if v, ok := findHwmonSensor(dir, "freq", "mclk"); ok && v > 0 {
			s["GFX_MCLK"] = v / 1e6
		}
	}
	if clk := readCurrentClockMHz(filepath.Join(base, "pp_dpm_fclk")); clk > 0 {
		s["FCLK"] = clk
	}

	return s
}
