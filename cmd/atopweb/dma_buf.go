package main

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

var readDmaBufErrOnce sync.Once

// readDmaBufBytes sums the size column of /sys/kernel/debug/dma_buf/bufinfo.
// Requires CAP_SYS_ADMIN for debugfs access.  On permission failure the
// reason is reported once via diag.report() so the dashboard log pane shows
// the user why the dma-buf total is missing.
func readDmaBufBytes() uint64 {
	data, err := os.ReadFile("/sys/kernel/debug/dma_buf/bufinfo")
	if err != nil {
		readDmaBufErrOnce.Do(func() {
			if os.IsPermission(err) {
				diag.report("dma-buf total unavailable: /sys/kernel/debug/dma_buf/bufinfo permission denied — the service needs CAP_SYS_ADMIN to read debugfs")
			} else if os.IsNotExist(err) {
				diag.report("dma-buf total unavailable: /sys/kernel/debug/dma_buf/bufinfo does not exist — debugfs is probably not mounted or the dma-buf subsystem is absent")
			} else {
				diag.report("dma-buf total unavailable: %v", err)
			}
		})
		return 0
	}
	var total uint64
	for _, line := range strings.Split(string(data), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		// First column is size in bytes for object rows; header/separator
		// lines begin with non-digit characters and are skipped by ParseUint.
		if v, err := strconv.ParseUint(f[0], 10, 64); err == nil {
			total += v
		}
	}
	return total
}
