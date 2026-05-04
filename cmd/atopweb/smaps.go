package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// anonStats bundles the smaps_rollup anonymous-RSS fields we surface per-PID.
// PssAnon is the proportional anonymous resident set; AnonHugePages is the
// portion of that backed by transparent huge pages (a strong heuristic for
// ROCm UMA model weights, which get THP-promoted thanks to large contiguous
// mmaps; ordinary heap/stack rarely produces THP at any meaningful scale).
type anonStats struct {
	PssAnonKiB       uint64
	AnonHugePagesKiB uint64
}

// readAnonStatsByPid reads /proc/<pid>/smaps_rollup for each PID and returns
// a map of pid → anonStats.  Pss_Anon is the proportional set size of
// anonymous pages — when multiple processes share a page (fork+COW, etc.)
// each gets only its proportional share, so the sum across all processes
// equals the system-wide anonymous page count.  AnonHugePages is the THP
// portion (whole-RSS, not Pss; smaps_rollup does not split THP into private
// vs shared) — close enough for a "ROCm-likely" signal since GPU processes
// rarely fork heavy anon state.  Requires kernel 4.14+ for smaps_rollup with
// Pss_Anon.  PIDs that disappear or lack permissions are omitted.
func readAnonStatsByPid(pids []int) map[int]anonStats {
	result := make(map[int]anonStats, len(pids))
	var permDenied bool
	for _, pid := range pids {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/smaps_rollup", pid))
		if err != nil {
			if os.IsPermission(err) {
				permDenied = true
			}
			continue
		}
		var s anonStats
		for _, line := range strings.Split(string(data), "\n") {
			var dst *uint64
			switch {
			case strings.HasPrefix(line, "Pss_Anon:"):
				dst = &s.PssAnonKiB
			case strings.HasPrefix(line, "AnonHugePages:"):
				dst = &s.AnonHugePagesKiB
			default:
				continue
			}
			f := strings.Fields(line)
			if len(f) >= 2 {
				if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
					*dst = v
				}
			}
		}
		result[pid] = s
	}
	if permDenied {
		diag.report("smaps_rollup scan: permission denied for some GPU PIDs — GPU app memory totals will be incomplete until the service gains CAP_SYS_PTRACE")
	}
	return result
}
