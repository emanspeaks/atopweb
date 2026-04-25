//go:build linux

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// DRAM bandwidth from AMD Data Fabric perf counters.
//
// We attach 24 perf_event_open() fds at startup — one for each
//   amd_df/local_or_remote_socket_{read,write}_data_beats_dram_<channel>
// event for channels 0..11.  Each "data beat" is a 32-byte transfer at the
// DF link width on Zen 5; sum the per-channel deltas, multiply by 32, divide
// by elapsed wall time = bytes per second.
//
// amd_df has ~8 hardware counter slots so the 24 events get round-robined by
// the kernel.  We tighten perf_event_mux_interval_ms to 1 ms at startup so
// each event sees uniform coverage across our (~100 ms) tick, and scale the
// raw counter by enabled_time/running_time on every read to compensate for
// the duty cycle.
//
// Why this and not amdgpu_top: amdgpu_top has a known bug where DRAM read
// and write counters get reported in the wrong order.  Going direct to the
// hardware via perf eliminates that translation layer entirely.

const (
	dramBytesPerBeat    = 32 // DF link width on Zen 5
	dramNumChannels     = 12
	dramMuxIntervalPath = "/sys/bus/event_source/devices/amd_df/perf_event_mux_interval_ms"
	dramMuxIntervalMs   = 1
)

// dramBeatsConfig returns the perf_event_attr.config word for the AMD DF
//
//	local_or_remote_socket_<read|write>_data_beats_dram_<channel>
//
// event.  Reverse-engineered from `perf stat -vv` output on Strix Halo /
// kernel 7.0.x.  The /sys/bus/event_source/devices/amd_df/format/ spec
// declares event=config[0:7]|config[32:37]<<8 and umask=config[8:15]|
// config[24:27]<<8.  The 12 DRAM channel events differ in only three places:
//
//	config bits  6-7    = (channel & 3)         low 2 bits of channel index
//	config bits 32-33   = (channel >> 2)        high 2 bits of channel index
//	config bit   8      = 0 (read)  / 1 (write) read/write toggles umask LSB
//
// Constant base bits 0x0F00FE1F encode the rest of the event-id and umask
// fields.  The PMU type is read at runtime from
// /sys/bus/event_source/devices/amd_df/type — it is kernel-assigned and must
// never be hardcoded.  If perf_list ever stops accepting these names on a
// future kernel, re-derive with:
//
//	sudo perf stat -vv -e 'amd_df/local_or_remote_socket_read_data_beats_dram_0/' \
//	                   -e 'amd_df/local_or_remote_socket_write_data_beats_dram_0/' \
//	                   -e 'amd_df/local_or_remote_socket_read_data_beats_dram_4/' \
//	                   -e 'amd_df/local_or_remote_socket_read_data_beats_dram_8/' \
//	                   -- sleep 0.05 2>&1 | grep config
func dramBeatsConfig(channel int, write bool) uint64 {
	cfg := uint64(0x0F00FE1F)
	cfg |= uint64(channel&3) << 6
	cfg |= uint64(channel>>2) << 32
	if write {
		cfg |= 1 << 8
	}
	return cfg
}

type dramBWMonitor struct {
	mu          sync.Mutex
	fds         []int    // 24: even index = reads, odd index = writes
	lastScaled  []uint64 // last (multiplex-scaled) counter value per fd
	lastTime    time.Time
	available   bool
	initialized bool
}

var dramBW = &dramBWMonitor{}

// modprobeBins lists absolute paths to try when modprobe is not in PATH.
// Services commonly run with a stripped PATH, so we search known locations
// across major distros and NixOS before giving up.
var modprobeBins = []string{
	"/sbin/modprobe",                        // traditional FHS
	"/usr/sbin/modprobe",                    // FHS 3.0+
	"/usr/bin/modprobe",                     // merged-usr distros (Arch, Fedora 37+)
	"/bin/modprobe",                         // some embedded / minimal systems
	"/run/current-system/sw/bin/modprobe",   // NixOS (kmod in systemPackages)
}

// findModprobe returns an absolute path to modprobe, searching PATH first
// and then well-known locations so the service works even with a stripped PATH.
// Returns "" if not found anywhere.
func findModprobe() string {
	if p, err := exec.LookPath("modprobe"); err == nil {
		return p
	}
	for _, p := range modprobeBins {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// loadDRAMBWModules best-effort modprobes the kernel modules we need so the
// service can self-bootstrap even when boot.kernelModules wasn't set or the
// user is running the binary manually before a reboot.  Failures are logged
// to journald but not fatal: if modules are already built-in or loaded the
// subsequent /sys check will succeed; if they genuinely aren't present,
// perf_event_open will surface the real reason via diag.report.
func loadDRAMBWModules() {
	modprobe := findModprobe()
	if modprobe == "" {
		log.Printf("atopweb dram bw: modprobe not found in PATH or well-known locations — assuming modules are already built-in or loaded")
		return
	}
	for _, mod := range []string{"amd_uncore", "amd_atl"} {
		if err := exec.Command(modprobe, mod).Run(); err != nil {
			log.Printf("atopweb dram bw: %s %s: %v (best-effort; may already be built-in)", modprobe, mod, err)
		}
	}
}

// initDRAMBW opens the 24 perf events and primes the counters.  Idempotent.
// Failure is non-fatal: the dashboard simply won't show DRAM BW until the
// service restarts (typically after the user installs a kernel that ships
// the amd_uncore + amd_atl modules).  Diagnostics surface via diag.report.
func initDRAMBW() {
	dramBW.mu.Lock()
	defer dramBW.mu.Unlock()
	if dramBW.initialized {
		return
	}
	dramBW.initialized = true

	loadDRAMBWModules()

	if _, err := os.Stat("/sys/bus/event_source/devices/amd_df"); err != nil {
		diag.report("dram bw: amd_df PMU not present (%v) — load kernel modules amd_uncore and amd_atl to enable DRAM bandwidth monitoring (NixOS: boot.kernelModules = [ \"amd_uncore\" \"amd_atl\" ];)", err)
		return
	}

	// PMU type is assigned dynamically by the kernel at boot — never hardcode it.
	typeBytes, err := os.ReadFile("/sys/bus/event_source/devices/amd_df/type")
	if err != nil {
		diag.report("dram bw: could not read amd_df PMU type (%v)", err)
		return
	}
	var dfType uint32
	if n, _ := fmt.Sscanf(string(typeBytes), "%d", &dfType); n != 1 {
		diag.report("dram bw: could not parse amd_df PMU type from %q", typeBytes)
		return
	}
	log.Printf("atopweb dram bw: amd_df PMU type = %d", dfType)

	// Uncore PMUs must be opened on a CPU listed in their cpumask, not an
	// arbitrary CPU.  Read it rather than assuming CPU 0.
	dfCPU := 0
	if cpuBytes, err := os.ReadFile("/sys/bus/event_source/devices/amd_df/cpumask"); err == nil {
		fmt.Sscanf(string(cpuBytes), "%d", &dfCPU)
	}
	log.Printf("atopweb dram bw: using CPU %d (from cpumask)", dfCPU)

	// Tighten DF multiplex rotation so 24 events through ~8 slots see uniform
	// coverage at our tick rate.  Best effort — failure just means slightly
	// more variance at 100 ms cadence.
	if err := os.WriteFile(dramMuxIntervalPath, []byte(fmt.Sprintf("%d\n", dramMuxIntervalMs)), 0); err != nil {
		diag.report("dram bw: could not write %s (%v) — DRAM BW readings may be jittery at sub-second cadence; default mux interval still works", dramMuxIntervalPath, err)
	}

	fds := make([]int, 0, 24)
	for ch := 0; ch < dramNumChannels; ch++ {
		for w := 0; w < 2; w++ {
			attr := unix.PerfEventAttr{
				Type:        dfType,
				Config:      dramBeatsConfig(ch, w == 1),
				Read_format: unix.PERF_FORMAT_TOTAL_TIME_ENABLED | unix.PERF_FORMAT_TOTAL_TIME_RUNNING,
			}
			attr.Size = uint32(unsafe.Sizeof(attr))
			// pid=-1 (any process), cpu from cpumask, groupFd=-1, flags=0.
			fd, err := unix.PerfEventOpen(&attr, -1, dfCPU, -1, 0)
			if err != nil {
				for _, f := range fds {
					unix.Close(f)
				}
				diag.report("dram bw: perf_event_open failed for amd_df channel %d %s (%v) — DRAM BW chart will not populate; check that the service runs as root with CAP_PERFMON", ch, []string{"read", "write"}[w], err)
				return
			}
			fds = append(fds, fd)
		}
	}

	dramBW.fds = fds
	dramBW.lastScaled = make([]uint64, 24)

	// Prime the counters so the first delta is from now-onward, not zero-onward.
	var buf [3]uint64
	bb := (*[24]byte)(unsafe.Pointer(&buf[0]))[:]
	for i, fd := range fds {
		if n, err := unix.Read(fd, bb); err == nil && n == 24 {
			value, enabled, running := buf[0], buf[1], buf[2]
			if running > 0 {
				dramBW.lastScaled[i] = uint64(float64(value) * float64(enabled) / float64(running))
			}
		}
	}
	dramBW.lastTime = time.Now()
	dramBW.available = true
	log.Printf("atopweb dram bw: opened 24 perf event fds for AMD DF DRAM bandwidth monitoring")
}

// readDRAMBW returns the read/write bandwidth in bytes per second over the
// elapsed window since the last call.  ok=false when the PMU is unavailable
// or a counter read fails.  Safe under concurrent calls; serializes on the
// monitor's mutex.
func readDRAMBW() (readBps, writeBps uint64, ok bool) {
	dramBW.mu.Lock()
	defer dramBW.mu.Unlock()
	if !dramBW.available {
		return 0, 0, false
	}

	now := time.Now()
	elapsed := now.Sub(dramBW.lastTime)
	if elapsed <= 0 {
		return 0, 0, false
	}

	var buf [3]uint64
	bb := (*[24]byte)(unsafe.Pointer(&buf[0]))[:]
	var readBeats, writeBeats uint64
	for i, fd := range dramBW.fds {
		n, err := unix.Read(fd, bb)
		if err != nil || n != 24 {
			dramBW.available = false
			diag.report("dram bw: perf counter read failed for fd index %d (err=%v, n=%d) — DRAM BW chart zeroed; restart the service to retry", i, err, n)
			return 0, 0, false
		}
		value, enabled, running := buf[0], buf[1], buf[2]
		if running == 0 {
			// Counter never armed in this window — no contribution from this
			// event but the others may still be valid.
			continue
		}
		// Scale by enabled/running for multiplexing compensation.  Use float64
		// to avoid uint64 overflow on long-running counters; 52-bit mantissa
		// is plenty given the ~1.0–3.0 scaling factors we expect.
		scaled := uint64(float64(value) * float64(enabled) / float64(running))
		var delta uint64
		if scaled >= dramBW.lastScaled[i] {
			delta = scaled - dramBW.lastScaled[i]
		}
		dramBW.lastScaled[i] = scaled
		if i%2 == 0 {
			readBeats += delta
		} else {
			writeBeats += delta
		}
	}

	dramBW.lastTime = now
	elapsedNs := uint64(elapsed.Nanoseconds())
	readBps = readBeats * dramBytesPerBeat * uint64(time.Second) / elapsedNs
	writeBps = writeBeats * dramBytesPerBeat * uint64(time.Second) / elapsedNs
	return readBps, writeBps, true
}
