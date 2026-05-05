package main

import (
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// memReservation is the authoritative memory layout report, derived from
// /sys/firmware/memmap plus (when available) AMD MSRs.  All byte counts are
// exact; *MiB fields are rounded-down MiB for JSON friendliness.
//
// FirmwareReservedKiB captures ALL DRAM reserved by firmware — above top of
// System RAM (typically BIOS VRAM carveout + PSP/SMU/ACPI runtime), inside the
// low-DRAM range (ACPI NVS/Tables, TSEG, small reserved blocks), plus any
// "hidden" bytes below TOP_MEM the firmware didn't advertise in e820 at all.
// VRAM is included in this number; JS subtracts the amdgpu-reported VRAM total
// to derive the non-VRAM portion.
type memReservation struct {
	SystemRAMTopBytes   uint64 `json:"system_ram_top_bytes,omitempty"`  // end-exclusive top of last "System RAM" entry in e820
	SystemRAMKiB        uint64 `json:"system_ram_kib,omitempty"`        // sum of all "System RAM" entries (kernel-addressable DRAM)
	TopMemBytes         uint64 `json:"top_mem_bytes,omitempty"`         // MSR TOP_MEM (low DRAM boundary)
	TopMem2Bytes        uint64 `json:"top_mem2_bytes,omitempty"`        // MSR TOP_MEM2 (upper DRAM boundary)
	TsegBaseBytes       uint64 `json:"tseg_base_bytes,omitempty"`       // SMM_ADDR (TSEG base), 0 if TSEG not enabled
	TsegSizeBytes       uint64 `json:"tseg_size_bytes,omitempty"`       // TSEG size decoded from SMM_MASK
	InstalledKiB        uint64 `json:"installed_kib,omitempty"`         // MSR-derived: TOP_MEM + (TOP_MEM2 - 4 GiB)
	FirmwareReservedKiB uint64 `json:"firmware_reserved_kib,omitempty"` // total DRAM reserved by firmware (above-ToM + low-memory + hidden gap; includes VRAM)
	FirmwareHighKiB     uint64 `json:"firmware_high_kib,omitempty"`     // DRAM reserved above top of System RAM (VRAM carveout + PSP/SMU/runtime)
	FirmwareLowKiB      uint64 `json:"firmware_low_kib,omitempty"`      // DRAM reserved below TOP_MEM (ACPI NVS/Tables, TSEG, small reserved) + any e820 gap
	SourceMSR           bool   `json:"source_msr,omitempty"`            // true if the above numbers used AMD MSRs (byte-exact); false if e820-only fallback
}

var (
	memReservationOnce sync.Once
	memReservationVal  memReservation
)

// readMemReservation assembles the memReservation report.  Cached: all inputs
// are static after boot.
//
// If MSRs are not readable (msr module not loaded, missing CAP_SYS_RAWIO, or
// the DAC check on /dev/cpu/*/msr fails) we do NOT fall back to an e820-only
// estimate — that approach over-counts by any PCI ECAM / MMIO region beyond
// TOP_MEM2 (typically ~770 MiB on Strix Halo), which would silently produce
// wrong numbers in the dashboard.  Instead the firmware-reservation fields
// stay zero, SourceMSR stays false, and a diagnostic is surfaced via
// diag.report() so the user sees in the dashboard log exactly why the bar is
// incomplete.
//
// The total firmware reservation is split into three components:
//   - High: DRAM above top of System RAM (VRAM carveout + PSP/SMU runtime).
//     Computed byte-exact from MSRs: TOP_MEM2 − top_of_System_RAM.
//   - Low: DRAM below TOP_MEM marked non-System-RAM in e820 (ACPI NVS/Tables,
//     TSEG, small Reserved blocks).  Sourced from e820 but clipped at TOP_MEM
//     so the result is DRAM-only (requires MSR TOP_MEM).
//   - Hidden: DRAM below TOP_MEM that firmware didn't advertise in e820 at all
//     (seen as a "gap" in dmesg).  Computed as TOP_MEM − sum(all e820 entries
//     below TOP_MEM).  Requires MSR TOP_MEM.
func readMemReservation() memReservation {
	memReservationOnce.Do(func() {
		// 1) Scan /sys/firmware/memmap.
		dirs, err := filepath.Glob("/sys/firmware/memmap/*")
		if err != nil || len(dirs) == 0 {
			return
		}
		type region struct {
			start, end uint64
			typ        string
		}
		regs := make([]region, 0, len(dirs))
		var topRAM, sysRAMBytes uint64
		parseHex := func(s string) (uint64, bool) {
			v, err := strconv.ParseUint(strings.TrimPrefix(s, "0x"), 16, 64)
			return v, err == nil
		}
		for _, d := range dirs {
			s, ok := parseHex(readFileTrim(filepath.Join(d, "start")))
			if !ok {
				continue
			}
			e, ok := parseHex(readFileTrim(filepath.Join(d, "end")))
			if !ok {
				continue
			}
			t := readFileTrim(filepath.Join(d, "type"))
			regs = append(regs, region{s, e, t})
			if t == "System RAM" {
				sysRAMBytes += e - s + 1
				if e > topRAM {
					topRAM = e
				}
			}
		}
		if topRAM == 0 {
			diag.report("readMemReservation: no 'System RAM' entries in /sys/firmware/memmap — memory-bar reconciliation will be incomplete")
			return
		}
		memReservationVal.SystemRAMTopBytes = topRAM + 1
		memReservationVal.SystemRAMKiB = sysRAMBytes / 1024

		// 2) AMD MSRs for authoritative DRAM topology.  No e820-only fallback
		// here: e820 "Reserved" entries mix DRAM reservations with MMIO
		// address space above TOP_MEM2, which would silently produce
		// inaccurate firmware-reservation numbers.  If the MSRs can't be
		// read we leave the corresponding fields zero and surface the reason
		// via diag.report() so the user sees it in the dashboard log.
		tom, errTom := readMSR(0, msrAMDTopMem)
		tom2, errTom2 := readMSR(0, msrAMDTopMem2)
		if errTom != nil || errTom2 != nil {
			err := errTom
			if err == nil {
				err = errTom2
			}
			diag.report("MSR TOP_MEM / TOP_MEM2 unreadable (%v) — firmware reservation segment, installed-DRAM total, and kernel-reserved segment will be blank until the msr kernel module is loaded and the service has CAP_SYS_RAWIO with read access to /dev/cpu/0/msr", err)
			return
		}

		memReservationVal.TopMemBytes = tom
		memReservationVal.TopMem2Bytes = tom2
		memReservationVal.SourceMSR = true

		// Installed DRAM = low DRAM (0..TOP_MEM) + high DRAM (4 GiB..TOP_MEM2).
		const fourGiB uint64 = 4 << 30
		if tom2 > fourGiB {
			memReservationVal.InstalledKiB = (tom + (tom2 - fourGiB)) / 1024
		}

		// High firmware reservation: byte-exact from MSRs.
		var highBytes uint64
		if tom2 > topRAM+1 {
			highBytes = tom2 - (topRAM + 1)
		}

		// Low firmware reservation: e820 non-SystemRAM entries clipped at
		// TOP_MEM, plus the hidden-gap (TOP_MEM − sum of all e820 entries
		// below TOP_MEM) that firmware never advertised.
		var lowBytes, accountedLow uint64
		for _, r := range regs {
			if r.start >= tom {
				continue
			}
			end := r.end
			if end >= tom {
				end = tom - 1
			}
			accountedLow += end - r.start + 1
			if r.typ != "System RAM" {
				lowBytes += end - r.start + 1
			}
		}
		var hiddenBytes uint64
		if tom > accountedLow {
			hiddenBytes = tom - accountedLow
		}

		memReservationVal.FirmwareHighKiB = highBytes / 1024
		memReservationVal.FirmwareLowKiB = (lowBytes + hiddenBytes) / 1024
		memReservationVal.FirmwareReservedKiB = (highBytes + lowBytes + hiddenBytes) / 1024

		// TSEG: base in SMM_ADDR bits 51:17, size decoded from SMM_MASK.
		addr, errAddr := readMSR(0, msrAMDSMMAddr)
		mask, errMask := readMSR(0, msrAMDSMMMask)
		if errAddr != nil || errMask != nil {
			err := errAddr
			if err == nil {
				err = errMask
			}
			diag.report("MSR SMM_ADDR / SMM_MASK unreadable (%v) — TSEG base/size unknown; Low firmware reservation still reflects e820 TSEG block but size is not independently verified", err)
			return
		}
		if (mask & 0x2) == 0 {
			return // TSEG valid bit clear — disabled on this system.
		}
		memReservationVal.TsegBaseBytes = addr &^ ((uint64(1) << 17) - 1)
		tsegMaskField := (mask >> 17) & ((uint64(1) << 35) - 1)
		size := uint64(1) << 17
		for tsegMaskField&1 == 0 && tsegMaskField != 0 {
			size <<= 1
			tsegMaskField >>= 1
		}
		memReservationVal.TsegSizeBytes = size
	})
	return memReservationVal
}
