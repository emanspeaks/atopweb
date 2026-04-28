package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

// readMSR reads an 8-byte model-specific register via /dev/cpu/<cpu>/msr.
// Requires the msr kernel module loaded and CAP_SYS_RAWIO (or root) on the
// calling process.  Returns error if the module isn't loaded, the capability
// isn't granted, or the MSR isn't implemented on this CPU.
func readMSR(cpu int, msr uint32) (uint64, error) {
	f, err := os.Open(fmt.Sprintf("/dev/cpu/%d/msr", cpu))
	if err != nil {
		return 0, err
	}
	defer f.Close()
	buf := make([]byte, 8)
	if _, err := f.ReadAt(buf, int64(msr)); err != nil {
		return 0, err
	}
	return binary.LittleEndian.Uint64(buf), nil
}

// AMD architectural MSRs used below.  See AMD64 Architecture Programmer's
// Manual vol.2 §15 and BKDG for Family 17h/19h/1Ah.
const (
	msrAMDTopMem  uint32 = 0xC001001A // Low DRAM boundary (end of 0–4 GiB DRAM range)
	msrAMDTopMem2 uint32 = 0xC001001D // Upper DRAM boundary (top of all physical DRAM)
	msrAMDSMMAddr uint32 = 0xC0010112 // TSEG base (bits 51:17)
	msrAMDSMMMask uint32 = 0xC0010113 // TSEG mask (bits 51:17) + ASeg/TSeg enables
)
