//go:build linux && cgo

package main

import (
	"encoding/binary"
	"fmt"
	"os"
)

// parseGPUMetrics reads the gpu_metrics binary sysfs file for the given card
// and returns a map suitable for JSON marshalling into the "gpu_metrics" field
// of the device frame.
//
// Temperature values are in centi-Celsius (frontend divides by 100 for °C).
// Power values are in milliwatts (frontend divides by 1000 for watts).
// Clock frequencies are in MHz.
func parseGPUMetrics(card int) map[string]interface{} {
	path := fmt.Sprintf("/sys/class/drm/renderD%d/device/gpu_metrics", 128+card)
	data, err := os.ReadFile(path)
	if err != nil || len(data) < 4 {
		return map[string]interface{}{}
	}

	formatRev := data[2]
	contentRev := data[3]

	switch formatRev {
	case 3:
		return parseMetricsV3(data, contentRev)
	case 2:
		return parseMetricsV2(data, contentRev)
	case 1:
		return parseMetricsV1(data, contentRev)
	}
	return map[string]interface{}{}
}

// gmu16 reads a little-endian uint16 at byte offset, returning 0 if out of bounds.
func gmu16(data []byte, off int) uint16 {
	if off+2 > len(data) {
		return 0
	}
	return binary.LittleEndian.Uint16(data[off:])
}

// gmu32 reads a little-endian uint32 at byte offset, returning 0 if out of bounds.
func gmu32(data []byte, off int) uint32 {
	if off+4 > len(data) {
		return 0
	}
	return binary.LittleEndian.Uint32(data[off:])
}

// parseMetricsV2 parses the APU gpu_metrics format (format_revision=2).
//
// All v2.x versions (v2.1–v2.4) share the same base field layout; newer
// content_revisions only append fields at the end without disturbing earlier
// offsets.
//
// Verified from Linux kernel kgd_pp_interface.h struct gpu_metrics_v2_1.
// v2.1 base layout (120 bytes total):
//
//	offset  0: structure_size (u16) + format/content revision bytes = 4 B header
//	offset  4: temperature_gfx (u16)  centi-°C
//	offset  6: temperature_soc (u16)  centi-°C
//	offset  8: temperature_core[8] (u16×8 = 16 B)
//	offset 24: temperature_l3[2]   (u16×2 =  4 B)
//	offset 28: average_gfx_activity (u16)
//	offset 30: average_mm_activity  (u16)
//	offset 32: system_clock_counter (u64 = 8 B)   ← 8-byte aligned naturally
//	offset 40: average_socket_power (u16) mW
//	offset 42: average_cpu_power    (u16) mW  → emitted as average_all_core_power
//	offset 44: average_soc_power    (u16) mW
//	offset 46: average_gfx_power    (u16) mW
//	offset 48: average_core_power[8] (u16×8 = 16 B) mW
//	offset 64: average_gfxclk_frequency  (u16) MHz
//	offset 66: average_socclk_frequency  (u16) MHz
//	offset 68: average_uclk_frequency    (u16) MHz
//	offset 70: average_fclk_frequency    (u16) MHz
//	offset 72: average_vclk_frequency    (u16) MHz
//	offset 74: average_dclk_frequency    (u16) MHz
//	offset 76: current_gfxclk   (u16) MHz
//	offset 78: current_socclk   (u16) MHz
//	offset 80: current_uclk     (u16) MHz
//	offset 82: current_fclk     (u16) MHz
//	offset 84: current_vclk     (u16) MHz
//	offset 86: current_dclk     (u16) MHz
//	offset 88: current_coreclk[8] (u16×8 = 16 B) MHz
//	offset 104: current_l3clk[2]  (u16×2 =  4 B) MHz
//	offset 108: throttle_status   (u32 = 4 B)
//	offset 112: fan_pwm           (u16)
//	offset 114: padding[3]        (u16×3 = 6 B)
//	— v2.1 ends at 120 B —
//	— v2.2 appends: indep_throttle_status (u64) at 120 → ends at 128 B —
//	— v2.3 appends: average_temperature_gfx/soc/core[8]/l3[2] at 128 → ends at 152 B —
//	— v2.4 appends: voltages+currents at 152 → ends at 164 B —
func parseMetricsV2(data []byte, _ uint8) map[string]interface{} {
	if len(data) < 90 {
		return map[string]interface{}{}
	}
	m := make(map[string]interface{})

	// Temperatures (centi-°C — frontend divides by 100)
	m["temperature_gfx"] = gmu16(data, 4)
	m["temperature_soc"] = gmu16(data, 6)

	// Per-core temperatures (centi-°C, 8 cores)
	coreTemp := make([]uint16, 8)
	for j := range coreTemp {
		coreTemp[j] = gmu16(data, 8+j*2)
	}
	m["temperature_core"] = coreTemp

	// Activity percentages
	m["average_gfx_activity"] = gmu16(data, 28)
	m["average_mm_activity"] = gmu16(data, 30)

	// Power (milliwatts)
	m["average_socket_power"] = gmu16(data, 40)
	// average_cpu_power is the total CPU power; map it to average_all_core_power
	// which is what the frontend chart "CPU Cores Total" expects.
	m["average_all_core_power"] = gmu16(data, 42)

	// Per-core power array (mW each, 8 cores)
	corePwr := make([]uint16, 8)
	for j := range corePwr {
		corePwr[j] = gmu16(data, 48+j*2)
	}
	m["average_core_power"] = corePwr

	// Average clock frequencies (MHz)
	if f := gmu16(data, 64); f > 0 {
		m["average_gfxclk_frequency"] = f
	}
	if f := gmu16(data, 66); f > 0 {
		m["average_socclk_frequency"] = f
	}
	if f := gmu16(data, 68); f > 0 {
		m["average_uclk_frequency"] = f
	}
	if f := gmu16(data, 70); f > 0 {
		m["average_fclk_frequency"] = f
	}
	if f := gmu16(data, 72); f > 0 {
		m["average_vclk_frequency"] = f
	}

	// Per-core current clock frequencies (MHz, 8 cores)
	if len(data) >= 104 {
		coreClk := make([]uint16, 8)
		for j := range coreClk {
			coreClk[j] = gmu16(data, 88+j*2)
		}
		m["current_coreclk"] = coreClk
	}

	return m
}

// parseMetricsV3 parses the latest APU gpu_metrics format (format_revision=3,
// content_revision=0). Used on Phoenix / Hawk Point APUs.
//
// Verified from Linux kernel kgd_pp_interface.h struct gpu_metrics_v3_0.
// Selected offsets (implicit C struct padding applied by compiler):
//
//	offset  4: temperature_gfx (u16) centi-°C
//	offset  6: temperature_soc (u16) centi-°C
//	offset  8: temperature_core[16] (u16×16 = 32 B)
//	offset 40: temperature_skin (u16)
//	offset 42: average_gfx_activity (u16)
//	offset 44: average_vcn_activity (u16)
//	offset 46: average_ipu_activity[8] (u16×8 = 16 B)
//	offset 62: average_core_c0_activity[16] (u16×16 = 32 B)
//	offset 94: average_dram_reads/writes, ipu_reads/writes (u16×4 = 8 B)
//	offset 102: implicit 2 B padding to align u64
//	offset 104: system_clock_counter (u64)
//	offset 112: average_socket_power (u32) mW
//	offset 116: average_ipu_power    (u16) mW
//	offset 118: implicit 2 B padding to align u32
//	offset 120: average_apu_power    (u32) mW
//	offset 124: average_gfx_power    (u32) mW
//	offset 128: average_dgpu_power   (u32) mW
//	offset 132: average_all_core_power (u32) mW
//	offset 136: average_core_power[16] (u16×16 = 32 B) mW
//	offset 168: average_sys_power, stapm limits (u16×3 = 6 B)
//	offset 174: average_gfxclk_frequency  (u16) MHz
//	offset 176: average_socclk_frequency  (u16) MHz
//	offset 178: average_vpeclk_frequency  (u16) MHz
//	offset 180: average_ipuclk_frequency  (u16) MHz
//	offset 182: average_fclk_frequency    (u16) MHz
//	offset 184: average_vclk_frequency    (u16) MHz
//	offset 186: average_uclk_frequency    (u16) MHz
//	offset 188: average_mpipu_frequency   (u16) MHz
//	offset 190: current_coreclk[16] (u16×16 = 32 B) MHz
func parseMetricsV3(data []byte, _ uint8) map[string]interface{} {
	if len(data) < 190 {
		return map[string]interface{}{}
	}
	m := make(map[string]interface{})

	m["temperature_gfx"] = gmu16(data, 4)
	m["temperature_soc"] = gmu16(data, 6)
	m["temperature_skin"] = gmu16(data, 40)

	// Per-core temperatures (centi-°C, 16 cores)
	coreTemp := make([]uint16, 16)
	for j := range coreTemp {
		coreTemp[j] = gmu16(data, 8+j*2)
	}
	m["temperature_core"] = coreTemp

	// Activity percentages
	m["average_gfx_activity"] = gmu16(data, 42)
	m["average_vcn_activity"] = gmu16(data, 44)

	// IPU (NPU) activity across 8 engines
	ipuAct := make([]uint16, 8)
	for j := range ipuAct {
		ipuAct[j] = gmu16(data, 46+j*2)
	}
	m["average_ipu_activity"] = ipuAct

	// DRAM and IPU bandwidth
	m["average_dram_reads"] = gmu16(data, 94)
	m["average_dram_writes"] = gmu16(data, 96)
	m["average_ipu_reads"] = gmu16(data, 98)
	m["average_ipu_writes"] = gmu16(data, 100)

	// Power (mW)
	m["average_socket_power"] = gmu32(data, 112)
	m["average_ipu_power"] = gmu16(data, 116)
	m["average_apu_power"] = gmu32(data, 120)
	m["average_gfx_power"] = gmu32(data, 124)
	m["average_all_core_power"] = gmu32(data, 132)

	// Per-core power array (mW each, 16 cores)
	corePwr := make([]uint16, 16)
	for j := range corePwr {
		corePwr[j] = gmu16(data, 136+j*2)
	}
	m["average_core_power"] = corePwr

	m["average_sys_power"] = gmu16(data, 168)

	// Clock frequencies (MHz)
	if f := gmu16(data, 174); f > 0 {
		m["average_gfxclk_frequency"] = f
	}
	if f := gmu16(data, 176); f > 0 {
		m["average_socclk_frequency"] = f
	}
	if f := gmu16(data, 178); f > 0 {
		m["average_vpeclk_frequency"] = f
	}
	if f := gmu16(data, 180); f > 0 {
		m["average_ipuclk_frequency"] = f
	}
	if f := gmu16(data, 182); f > 0 {
		m["average_fclk_frequency"] = f
	}
	if f := gmu16(data, 184); f > 0 {
		m["average_vclk_frequency"] = f
	}
	if f := gmu16(data, 186); f > 0 {
		m["average_uclk_frequency"] = f
	}
	if f := gmu16(data, 188); f > 0 {
		m["average_mpipu_frequency"] = f
	}

	// Per-core current clocks (16 cores)
	if len(data) >= 222 {
		coreClk := make([]uint16, 16)
		for j := range coreClk {
			coreClk[j] = gmu16(data, 190+j*2)
		}
		m["current_coreclk"] = coreClk
	}

	return m
}

// parseMetricsV1 parses the discrete GPU gpu_metrics format (format_revision=1).
// v1.0 is not recommended (alignment issues); this handles v1.1+.
//
// Verified from Linux kernel kgd_pp_interface.h struct gpu_metrics_v1_1.
// v1.1 layout:
//
//	offset  0: header (4 B)
//	offset  4: temperature_edge    (u16) centi-°C → emitted as temperature_gfx
//	offset  6: temperature_hotspot (u16) centi-°C
//	offset  8: temperature_mem     (u16) centi-°C
//	offset 10: temperature_vrgfx/vrsoc/vrmem (u16×3)
//	offset 16: average_gfx_activity (u16)
//	offset 18: average_umc_activity (u16)
//	offset 20: average_mm_activity  (u16)
//	offset 22: average_socket_power (u16) mW
//	offset 24: energy_accumulator   (u64 = 8 B)
//	offset 32: system_clock_counter (u64 = 8 B)
//	offset 40: average_gfxclk_frequency (u16) MHz
//	offset 42: average_socclk_frequency (u16) MHz
//	offset 44: average_uclk_frequency   (u16) MHz
//	offset 46: average_vclk0_frequency  (u16) MHz
func parseMetricsV1(data []byte, contentRev uint8) map[string]interface{} {
	if contentRev == 0 || len(data) < 40 {
		// v1.0 is not naturally aligned; skip it
		return map[string]interface{}{}
	}
	if len(data) < 48 {
		return map[string]interface{}{}
	}
	m := make(map[string]interface{})

	// Map edge temp → temperature_gfx for parity with v2 frontend expectations
	m["temperature_gfx"] = gmu16(data, 4)
	m["temperature_hotspot"] = gmu16(data, 6)
	m["temperature_mem"] = gmu16(data, 8)

	// Activity percentages (dGPU only)
	m["average_gfx_activity"] = gmu16(data, 16)
	m["average_umc_activity"] = gmu16(data, 18)
	m["average_mm_activity"] = gmu16(data, 20)

	m["average_socket_power"] = gmu16(data, 22)

	// Clock frequencies (available from v1.1+, starts at offset 40)
	if f := gmu16(data, 40); f > 0 {
		m["average_gfxclk_frequency"] = f
	}
	if f := gmu16(data, 42); f > 0 {
		m["average_socclk_frequency"] = f
	}
	if f := gmu16(data, 46); f > 0 {
		m["average_vclk_frequency"] = f
	}

	return m
}
