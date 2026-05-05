package main

import (
	"strconv"
	"strings"
)

// powerLimitsInfo holds the parsed power/thermal limits from ryzenadj.
// JSON keys match what the frontend power-limits.js expects.
type powerLimitsInfo struct {
	STAPMWatts     *float64 `json:"stapm_w,omitempty"`
	FastWatts      *float64 `json:"fast_w,omitempty"`
	SlowWatts      *float64 `json:"slow_w,omitempty"`
	APUSlowWatts   *float64 `json:"apu_slow_w,omitempty"`
	THMCoreCelsius *float64 `json:"thm_core_c,omitempty"`
	THMGFXCelsius  *float64 `json:"thm_gfx_c,omitempty"`
	THMSOCCelsius  *float64 `json:"thm_soc_c,omitempty"`
}

// parseRyzenAdjInfo extracts power and thermal limits from `ryzenadj -i` output.
//
// Modern ryzenadj output uses a leading "|" on every data row:
//
//	| STAPM LIMIT | 45000 | (bias) | (min) | (max) | mW |
//
// Older/alternative output may omit the leading "|":
//
//	stapm_limit | 45000 | mW
//
// Both formats are handled by detecting whether parts[0] is empty.
// The unit is found by scanning all columns after the value.
// Name matching is case-insensitive substring-based.
func parseRyzenAdjInfo(output string) powerLimitsInfo {
	var result powerLimitsInfo
	for _, line := range strings.Split(output, "\n") {
		parts := strings.Split(line, "|")
		if len(parts) < 3 {
			continue
		}
		// Leading "|" makes parts[0] empty — shift past it.
		off := 0
		if strings.TrimSpace(parts[0]) == "" {
			off = 1
		}
		if off+1 >= len(parts) {
			continue
		}
		name := strings.TrimSpace(parts[off])
		valStr := strings.TrimSpace(parts[off+1])
		if name == "" || name == "Name" {
			continue
		}
		val, err := strconv.ParseFloat(valStr, 64)
		if err != nil || val <= 0 {
			continue
		}
		// Scan remaining columns for the unit.
		unit := ""
		for idx := off + 2; idx < len(parts); idx++ {
			u := strings.ToLower(strings.TrimSpace(parts[idx]))
			if u == "mw" || u == "w" || u == "mdegc" || u == "degc" {
				unit = u
				break
			}
		}
		n := strings.ToLower(name)
		// Require "limit" in the name to avoid matching VALUE rows that appear
		// directly below each LIMIT row in the ryzenadj table.
		if !strings.Contains(n, "limit") {
			continue
		}
		switch {
		case strings.Contains(n, "stapm"):
			if w := toWatts(val, unit); w != nil {
				result.STAPMWatts = w
			}
		case strings.Contains(n, "fast") && strings.Contains(n, "ppt"):
			if w := toWatts(val, unit); w != nil {
				result.FastWatts = w
			}
		case strings.Contains(n, "slow") && strings.Contains(n, "ppt"):
			if w := toWatts(val, unit); w != nil {
				result.SlowWatts = w
			}
		case strings.Contains(n, "apu") && strings.Contains(n, "slow"):
			if w := toWatts(val, unit); w != nil {
				result.APUSlowWatts = w
			}
		case strings.Contains(n, "thm") && strings.Contains(n, "core"):
			if c := toCelsius(val, unit); c != nil {
				result.THMCoreCelsius = c
			}
		case strings.Contains(n, "thm") && strings.Contains(n, "gfx"):
			if c := toCelsius(val, unit); c != nil {
				result.THMGFXCelsius = c
			}
		case strings.Contains(n, "thm") && strings.Contains(n, "soc"):
			if c := toCelsius(val, unit); c != nil {
				result.THMSOCCelsius = c
			}
		}
	}
	return result
}

func toWatts(val float64, unit string) *float64 {
	var w float64
	switch unit {
	case "mw":
		w = val / 1000.0
	case "w":
		w = val
	default:
		if val > 500 {
			w = val / 1000.0
		} else {
			w = val
		}
	}
	return &w
}

func toCelsius(val float64, unit string) *float64 {
	var c float64
	switch unit {
	case "mdegc":
		c = val / 1000.0
	case "degc":
		c = val
	default:
		if val > 1000 {
			c = val / 1000.0
		} else {
			c = val
		}
	}
	return &c
}
