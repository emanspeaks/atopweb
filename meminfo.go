package main

import (
	"os"
	"strconv"
	"strings"
)

func readFileTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func mustReadFileOrEmpty(path string) []byte {
	b, _ := os.ReadFile(path)
	return b
}

// readMemInfoAll parses /proc/meminfo and returns key→value (kB for most fields,
// plain count for HugePages_*).
func readMemInfoAll() map[string]uint64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil
	}
	m := make(map[string]uint64)
	for _, line := range strings.Split(string(data), "\n") {
		idx := strings.IndexByte(line, ':')
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		fields := strings.Fields(line[idx+1:])
		if len(fields) == 0 {
			continue
		}
		if v, err := strconv.ParseUint(fields[0], 10, 64); err == nil {
			m[key] = v
		}
	}
	return m
}
