package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
)

var (
	coreRanksOnce sync.Once
	coreRanksData []int
)

// readCoreRanks reads /sys/devices/system/cpu/cpu*/acpi_cppc/highest_perf and
// returns a slice where ranks[j] is the performance rank of logical CPU j (1 = best).
// SMT siblings (same physical core) receive the same rank and are counted once,
// so ranks run 1..N_physical rather than 1..N_logical.
func readCoreRanks() []int {
	paths, _ := filepath.Glob("/sys/devices/system/cpu/cpu*/acpi_cppc/highest_perf")
	if len(paths) == 0 {
		return nil
	}

	readSysInt := func(path string) (int, bool) {
		data, err := os.ReadFile(path)
		if err != nil {
			return 0, false
		}
		n, err := strconv.Atoi(strings.TrimSpace(string(data)))
		return n, err == nil
	}

	type cpuEntry struct {
		logical int
		perf    int
		coreKey string // "pkg/coreID" — groups SMT siblings
	}

	var cpus []cpuEntry
	maxLogical := 0

	for _, p := range paths {
		cpuDir := filepath.Dir(filepath.Dir(p)) // .../cpu/cpuN
		n, err := strconv.Atoi(strings.TrimPrefix(filepath.Base(cpuDir), "cpu"))
		if err != nil {
			continue
		}
		perf, ok := readSysInt(p)
		if !ok {
			continue
		}
		pkgID, hasPkg := readSysInt(filepath.Join(cpuDir, "topology/physical_package_id"))
		coreID, hasCore := readSysInt(filepath.Join(cpuDir, "topology/core_id"))
		var coreKey string
		if hasPkg && hasCore {
			coreKey = fmt.Sprintf("%d/%d", pkgID, coreID)
		} else {
			coreKey = fmt.Sprintf("cpu%d", n) // topology unavailable: treat as unique
		}
		cpus = append(cpus, cpuEntry{n, perf, coreKey})
		if n > maxLogical {
			maxLogical = n
		}
	}
	if len(cpus) == 0 {
		return nil
	}

	// Group logical CPUs by physical core, keeping lowest logical index as representative.
	type physCore struct {
		minLogical int
		perf       int
		members    []int
	}
	byKey := map[string]*physCore{}
	for _, c := range cpus {
		if pc, ok := byKey[c.coreKey]; ok {
			pc.members = append(pc.members, c.logical)
			if c.logical < pc.minLogical {
				pc.minLogical = c.logical
				pc.perf = c.perf
			}
		} else {
			byKey[c.coreKey] = &physCore{c.logical, c.perf, []int{c.logical}}
		}
	}

	type pcEntry struct {
		minLogical int
		perf       int
		members    []int
	}
	phys := make([]pcEntry, 0, len(byKey))
	for _, pc := range byKey {
		phys = append(phys, pcEntry{pc.minLogical, pc.perf, pc.members})
	}
	sort.Slice(phys, func(i, j int) bool {
		if phys[i].perf != phys[j].perf {
			return phys[i].perf > phys[j].perf
		}
		return phys[i].minLogical < phys[j].minLogical
	})

	ranks := make([]int, maxLogical+1)
	for rank, pc := range phys {
		for _, logical := range pc.members {
			ranks[logical] = rank + 1
		}
	}
	return ranks
}

func serveCoreRanks(w http.ResponseWriter, r *http.Request) {
	coreRanksOnce.Do(func() { coreRanksData = readCoreRanks() })
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	ranks := coreRanksData
	if ranks == nil {
		ranks = []int{}
	}
	json.NewEncoder(w).Encode(map[string][]int{"ranks": ranks})
}
