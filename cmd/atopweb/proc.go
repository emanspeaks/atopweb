package main

import (
	"os"
	"strconv"
	"strings"
)

// readCPUStat reads the first "cpu" line from /proc/stat.
type cpuStat struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (s cpuStat) total() uint64 {
	return s.user + s.nice + s.system + s.idle + s.iowait + s.irq + s.softirq + s.steal
}

func readCPUStat() (cpuStat, bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuStat{}, false
	}
	for _, line := range strings.SplitN(string(data), "\n", 2) {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 9 {
			break
		}
		p := func(i int) uint64 { n, _ := strconv.ParseUint(f[i], 10, 64); return n }
		return cpuStat{
			user: p(1), nice: p(2), system: p(3), idle: p(4),
			iowait: p(5), irq: p(6), softirq: p(7), steal: p(8),
		}, true
	}
	return cpuStat{}, false
}

func readLoadAvg() [3]float64 {
	var avg [3]float64
	data, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return avg
	}
	fields := strings.Fields(string(data))
	for i := 0; i < 3 && i < len(fields); i++ {
		avg[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return avg
}

func readUptime() float64 {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) < 1 {
		return 0
	}
	sec, _ := strconv.ParseFloat(fields[0], 64)
	return sec
}
