package main

import (
	"path/filepath"
	"strconv"
	"strings"
)

// splitSensorName turns "fan1_input" → ("fan1", "fan"), "in0_input" → ("in0", "in").
func splitSensorName(base string) (prefix, kind string) {
	prefix = strings.TrimSuffix(base, "_input")
	for i := 0; i < len(prefix); i++ {
		if prefix[i] >= '0' && prefix[i] <= '9' {
			return prefix, prefix[:i]
		}
	}
	return prefix, prefix
}

// readHwmon walks /sys/class/hwmon/hwmon* and collects fan, voltage, current,
// power, and temperature sensors.  Returns five slices, one per sensor kind.
func readHwmon() (fans, volts, currs, pows, temps []sysSensor) {
	dirs, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, dir := range dirs {
		chip := readFileTrim(filepath.Join(dir, "name"))
		if chip == "" {
			chip = filepath.Base(dir)
		}
		inputs, _ := filepath.Glob(filepath.Join(dir, "*_input"))
		for _, input := range inputs {
			prefix, kind := splitSensorName(filepath.Base(input))
			valStr := readFileTrim(input)
			if valStr == "" {
				continue
			}
			val, err := strconv.ParseFloat(valStr, 64)
			if err != nil {
				continue
			}
			label := readFileTrim(filepath.Join(dir, prefix+"_label"))
			if label == "" {
				label = prefix
			}
			s := sysSensor{Chip: chip, Label: label, Value: val}
			switch kind {
			case "fan":
				fans = append(fans, s)
			case "in":
				volts = append(volts, s)
			case "curr":
				currs = append(currs, s)
			case "power":
				pows = append(pows, s)
			case "temp":
				s.Value = val / 1000 // m°C → °C
				temps = append(temps, s)
			}
		}
	}
	return
}
