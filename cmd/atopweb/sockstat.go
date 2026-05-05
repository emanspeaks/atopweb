package main

import (
	"os"
	"strconv"
	"strings"
)

// readSockMemKB returns the sum of TCP/UDP/FRAG socket buffer memory from
// /proc/net/sockstat (and sockstat6), converted to KiB.  The "mem" fields are
// in pages; we multiply by the system page size (4 KiB on x86_64).
func readSockMemKB() uint64 {
	var pages uint64
	for _, path := range []string{"/proc/net/sockstat", "/proc/net/sockstat6"} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			fields := strings.Fields(line)
			// Lines look like "TCP: inuse 10 orphan 0 tw 5 alloc 12 mem 3".
			for i := 0; i+1 < len(fields); i++ {
				if fields[i] == "mem" || fields[i] == "memory" {
					if n, err := strconv.ParseUint(fields[i+1], 10, 64); err == nil {
						pages += n
					}
				}
			}
		}
	}
	return pages * uint64(os.Getpagesize()) / 1024
}
