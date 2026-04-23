package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed VERSION
var versionFile string

var version = strings.TrimSpace(versionFile)

//go:embed dashboard.html dashboard.css dashboard.js
var static embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type hub struct {
	mu             sync.Mutex
	clients        map[*websocket.Conn]struct{}
	last           []byte
	intervalMs     int
	cancelFn       context.CancelFunc
	atopVersion    string          // amdgpu_top version string
	ryzenAdjArgs   []string        // nil if not configured; includes sudo prefix when needed
	powerCache     powerLimitsInfo // last successful ryzenadj result
}

func (h *hub) add(c *websocket.Conn) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *hub) remove(c *websocket.Conn) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
}

func (h *hub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.last = msg
	for c := range h.clients {
		if err := c.WriteMessage(websocket.TextMessage, msg); err != nil {
			c.Close()
			delete(h.clients, c)
		}
	}
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	h.add(conn)
	defer h.remove(conn)
	// drain client frames to detect disconnection
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

func runStreamer(binary string, baseArgs []string, h *hub) {
	for {
		h.mu.Lock()
		ms := h.intervalMs
		h.mu.Unlock()

		args := append(append([]string{}, baseArgs...), "-s", strconv.Itoa(ms))
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.Command(binary, args...)
		// Put the process in its own group so we can kill sudo + amdgpu_top
		// together. exec.CommandContext only kills the named binary (sudo), but
		// amdgpu_top inherits sudo's stdout pipe FD and keeps the scanner alive.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

		var stderr bytes.Buffer
		cmd.Stderr = &stderr

		h.mu.Lock()
		h.cancelFn = cancel
		h.mu.Unlock()

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			cancel()
			h.mu.Lock()
			h.cancelFn = nil
			h.mu.Unlock()
			log.Printf("amdgpu_top pipe error: %v; retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			cancel()
			h.mu.Lock()
			h.cancelFn = nil
			h.mu.Unlock()
			log.Printf("amdgpu_top failed to start: %v; retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}

		go func() {
			<-ctx.Done()
			if cmd.Process != nil {
				syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
			// Close the read end of the pipe so the scanner unblocks
			// immediately even if amdgpu_top (sudo's child) outlives sudo.
			stdout.Close()
		}()

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4<<20), 4<<20) // 4 MiB; JSON frames can be large
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			frame := make([]byte, len(line))
			copy(frame, line)
			h.broadcast(frame)
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			log.Printf("amdgpu_top read error: %v", err)
		}

		wasKilled := ctx.Err() != nil
		cancel()
		cmd.Wait()

		h.mu.Lock()
		h.cancelFn = nil
		h.mu.Unlock()

		if msg := strings.TrimSpace(stderr.String()); msg != "" && !wasKilled {
			log.Printf("amdgpu_top stderr: %s", msg)
		}
		if wasKilled {
			h.mu.Lock()
			newMs := h.intervalMs
			h.mu.Unlock()
			log.Printf("amdgpu_top restarting at %d ms", newMs)
			time.Sleep(200 * time.Millisecond)
		} else {
			log.Printf("amdgpu_top exited unexpectedly; retrying in 5s")
			time.Sleep(5 * time.Second)
		}
	}
}

func buildAtopArgs(updateIdx, instance int, pci string, apu, single, nopc bool) []string {
	// -s (interval) is omitted here; runStreamer injects it dynamically so that
	// changing the interval via /api/interval takes effect without restarting atopweb.
	args := []string{
		"-J",
		"-u", strconv.Itoa(updateIdx),
	}
	if instance >= 0 {
		args = append(args, "-i", strconv.Itoa(instance))
	}
	if pci != "" {
		args = append(args, "--pci", pci)
	}
	if apu {
		args = append(args, "--apu")
	}
	if single {
		args = append(args, "--single")
	}
	if nopc {
		args = append(args, "--no-pc")
	}
	return args
}

// getAtopVersion probes the amdgpu_top binary for its version string.
func getAtopVersion(binary string) string {
	for _, arg := range []string{"--version", "-V"} {
		if out, err := exec.Command(binary, arg).Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return "unknown"
}

// ── GPU process event detection ──────────────────────────────────────────────
//
// Three-layer early-detection pipeline, all without elevated privileges:
//
//  Layer 1 – KFD poll: /sys/class/kfd/kfd/proc appears per-PID when a process
//             opens /dev/kfd (ROCm/HIP init).  Fires ~200 ms after open vs the
//             full amdgpu_top fdinfo poll interval.
//
//  Layer 2 – known-proc poll: once a process name has been seen in fdinfo,
//             it enters the learning cache.  On subsequent runs the proc name
//             watcher fires as soon as that name appears in /proc — before the
//             process touches the GPU at all.
//
//  Layer 3 – fdinfo (existing client-side): still the authoritative source for
//             STOP events and for first-time processes unknown to the cache.
//
// procEventTracker deduplicates start events across all three layers by PID.

type procEvent struct {
	Type   string `json:"type"`   // always "proc_event"
	Event  string `json:"event"`  // "start"
	PID    int    `json:"pid"`
	Name   string `json:"name"`
	TimeMs int64  `json:"time_ms"`
}

type procEventTracker struct {
	mu      sync.Mutex
	started map[int]bool
}

func newProcEventTracker() *procEventTracker {
	t := &procEventTracker{started: make(map[int]bool)}
	// Purge dead PIDs so that PID reuse doesn't suppress future events.
	go func() {
		tick := time.NewTicker(10 * time.Second)
		defer tick.Stop()
		for range tick.C {
			t.mu.Lock()
			for pid := range t.started {
				if _, err := os.Stat(fmt.Sprintf("/proc/%d", pid)); os.IsNotExist(err) {
					delete(t.started, pid)
				}
			}
			t.mu.Unlock()
		}
	}()
	return t
}

// tryStart marks pid started and returns true the first time; false on dup.
func (t *procEventTracker) tryStart(pid int) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.started[pid] {
		return false
	}
	t.started[pid] = true
	return true
}

func (t *procEventTracker) clear(pid int) {
	t.mu.Lock()
	delete(t.started, pid)
	t.mu.Unlock()
}

// gpuProcCache is a persistent set of process comm names known to use the GPU.
// Populated from amdgpu_top fdinfo; enables layer-2 early detection.
type gpuProcCache struct {
	mu    sync.RWMutex
	names map[string]bool
	path  string // JSON file path; "" = in-memory only
}

func loadGPUProcCache(path string) *gpuProcCache {
	c := &gpuProcCache{names: make(map[string]bool), path: path}
	if path == "" {
		return c
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return c
	}
	var names []string
	if err := json.Unmarshal(data, &names); err == nil {
		for _, n := range names {
			c.names[n] = true
		}
		log.Printf("gpu proc cache: loaded %d known names from %s", len(names), path)
	}
	return c
}

func (c *gpuProcCache) has(name string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.names[name]
}

// add returns true if name was newly added to the cache.
func (c *gpuProcCache) add(name string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.names[name] {
		return false
	}
	c.names[name] = true
	if c.path != "" {
		c.saveUnlocked()
	}
	return true
}

func (c *gpuProcCache) saveUnlocked() {
	names := make([]string, 0, len(c.names))
	for n := range c.names {
		names = append(names, n)
	}
	sort.Strings(names)
	data, _ := json.Marshal(names)
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, c.path)
}

// readProcName returns the comm string for pid by reading /proc/<pid>/comm,
// or "" if the process has already exited.
func readProcName(pid int) string {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (h *hub) broadcastProcEvent(ev procEvent) {
	data, err := json.Marshal(ev)
	if err != nil {
		return
	}
	h.broadcast(data)
}

// watchKFDProcs polls /sys/class/kfd/kfd/proc for new ROCm/HIP process opens.
// Each subdirectory name is a PID; it appears when the process opens /dev/kfd.
// No privileges required.  Falls back silently if KFD is absent.
func watchKFDProcs(h *hub, tracker *procEventTracker) {
	const kfdDir = "/sys/class/kfd/kfd/proc"
	if _, err := os.Stat(kfdDir); err != nil {
		log.Printf("kfd watcher: %s unavailable — ROCm start events will use fdinfo lag", kfdDir)
		return
	}
	log.Printf("kfd watcher: monitoring %s (200 ms poll)", kfdDir)

	known := make(map[int]bool)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		entries, err := os.ReadDir(kfdDir)
		if err != nil {
			continue
		}
		current := make(map[int]bool, len(entries))
		for _, e := range entries {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			current[pid] = true
			if known[pid] {
				continue
			}
			known[pid] = true
			name := readProcName(pid)
			if name == "" || !tracker.tryStart(pid) {
				continue
			}
			h.broadcastProcEvent(procEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("kfd watcher: start pid=%d name=%q", pid, name)
		}
		for pid := range known {
			if !current[pid] {
				delete(known, pid)
				tracker.clear(pid)
			}
		}
	}
}

// watchKnownGPUProcs polls /proc every 200 ms for new instances of process
// names that appear in the GPU proc cache.  This fires before the process
// touches the GPU — even before KFD is opened — for any program whose name
// has been seen in amdgpu_top fdinfo at least once before.
func watchKnownGPUProcs(h *hub, cache *gpuProcCache, tracker *procEventTracker) {
	log.Printf("known-proc watcher: active (200 ms poll of /proc)")
	known := make(map[int]bool)
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		entries, err := os.ReadDir("/proc")
		if err != nil {
			continue
		}
		current := make(map[int]bool, len(entries))
		for _, e := range entries {
			pid, err := strconv.Atoi(e.Name())
			if err != nil {
				continue
			}
			current[pid] = true
			if known[pid] {
				continue
			}
			name := readProcName(pid)
			if name == "" || !cache.has(name) {
				continue
			}
			known[pid] = true
			if !tracker.tryStart(pid) {
				continue
			}
			h.broadcastProcEvent(procEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("known-proc watcher: start pid=%d name=%q", pid, name)
		}
		for pid := range known {
			if !current[pid] {
				delete(known, pid)
				tracker.clear(pid)
			}
		}
	}
}

// minFdFrame is a minimal parse of the amdgpu_top JSON used only to extract
// process names for the GPU proc cache.
type minFdFrame struct {
	Devices []struct {
		Fdinfo     map[string]struct{ Name string `json:"name"` } `json:"fdinfo"`
		XdnaFdinfo map[string]struct{ Name string `json:"name"` } `json:"xdna_fdinfo"`
	} `json:"devices"`
}

// populateGPUProcCache reads the last amdgpu_top frame every 2 s and adds any
// visible process names to the learning cache.
func populateGPUProcCache(h *hub, cache *gpuProcCache) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		h.mu.Lock()
		raw := h.last
		h.mu.Unlock()
		if raw == nil {
			continue
		}
		var frame minFdFrame
		if err := json.Unmarshal(raw, &frame); err != nil {
			continue
		}
		for _, dev := range frame.Devices {
			for _, p := range dev.Fdinfo {
				if p.Name != "" && cache.add(p.Name) {
					log.Printf("gpu proc cache: learned %q", p.Name)
				}
			}
			for _, p := range dev.XdnaFdinfo {
				if p.Name != "" && cache.add(p.Name) {
					log.Printf("gpu proc cache: learned %q", p.Name)
				}
			}
		}
	}
}

// ── /api/config ───────────────────────────────────────────────────────────────

type configInfo struct {
	IntervalMs     int    `json:"interval_ms"`
	AtopwebVersion string `json:"atopweb_version"`
	AtopTopVersion string `json:"amdgpu_top_version"`
	TotalRAMMiB    uint64 `json:"total_ram_mib"`
}

func (h *hub) serveConfig(w http.ResponseWriter, r *http.Request) {
	total, _ := readMemInfo()
	h.mu.Lock()
	info := configInfo{
		IntervalMs:     h.intervalMs,
		AtopwebVersion: version,
		AtopTopVersion: h.atopVersion,
		TotalRAMMiB:    total,
	}
	h.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(info)
}

// ── /api/interval ─────────────────────────────────────────────────────────────

func (h *hub) serveSetInterval(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	ms, err := strconv.Atoi(r.URL.Query().Get("ms"))
	if err != nil || ms < 50 || ms > 60000 {
		http.Error(w, "ms must be 50–60000", http.StatusBadRequest)
		return
	}

	h.mu.Lock()
	old := h.intervalMs
	h.intervalMs = ms
	cancel := h.cancelFn
	h.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	log.Printf("update interval: %d ms → %d ms", old, ms)
	w.WriteHeader(http.StatusNoContent)
}

// ── /api/vram ────────────────────────────────────────────────────────────────

type atopFrame struct {
	Devices []atopDevice `json:"devices"`
}

type atopDevice struct {
	Info     map[string]interface{} `json:"Info"`
	Activity map[string]struct {
		Value float64 `json:"value"`
	} `json:"gpu_activity"`
	VRAM map[string]struct {
		Value float64 `json:"value"`
	} `json:"VRAM"`
	GPUMetrics struct {
		STAPMPowerLimit        *float64 `json:"stapm_power_limit"`
		CurrentSTAPMPowerLimit *float64 `json:"current_stapm_power_limit"`
	} `json:"gpu_metrics"`
}

type vramInfo struct {
	Name     string  `json:"name"`
	UsedMiB  float64 `json:"used_mib"`
	TotalMiB float64 `json:"total_mib"`
	UsedPct  float64 `json:"used_pct"`
}

func (h *hub) serveVRAM(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	raw := h.last
	h.mu.Unlock()

	if raw == nil {
		http.Error(w, "no data yet", http.StatusServiceUnavailable)
		return
	}

	var frame atopFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		http.Error(w, "parse error", http.StatusInternalServerError)
		return
	}

	result := make([]vramInfo, 0, len(frame.Devices))
	for i, dev := range frame.Devices {
		used  := dev.VRAM["Total VRAM Usage"].Value + dev.VRAM["Total GTT Usage"].Value
		total := dev.VRAM["Total VRAM"].Value + dev.VRAM["Total GTT"].Value
		var pct float64
		if total > 0 {
			pct = used / total * 100
		}
		name := fmt.Sprintf("GPU %d", i)
		if n, ok := dev.Info["DeviceName"].(string); ok && n != "" {
			name = n
		} else if n, ok := dev.Info["ASIC Name"].(string); ok && n != "" {
			name = n
		}
		result = append(result, vramInfo{
			Name:     name,
			UsedMiB:  used,
			TotalMiB: total,
			UsedPct:  pct,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// ── /api/gpu-pct ──────────────────────────────────────────────────────────────
// GfxPct maps to gpu_activity.GFX, which corresponds to the amdgpu driver's
// gpu_busy_percent — the same value most GPU monitors display as primary usage.

type gpuPctInfo struct {
	Name   string  `json:"name"`
	GpuPct float64 `json:"gpu_pct"`
}

func (h *hub) serveGPUPct(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	raw := h.last
	h.mu.Unlock()

	if raw == nil {
		http.Error(w, "no data yet", http.StatusServiceUnavailable)
		return
	}

	var frame atopFrame
	if err := json.Unmarshal(raw, &frame); err != nil {
		http.Error(w, "parse error", http.StatusInternalServerError)
		return
	}

	result := make([]gpuPctInfo, 0, len(frame.Devices))
	for i, dev := range frame.Devices {
		name := fmt.Sprintf("GPU %d", i)
		if n, ok := dev.Info["DeviceName"].(string); ok && n != "" {
			name = n
		} else if n, ok := dev.Info["ASIC Name"].(string); ok && n != "" {
			name = n
		}
		result = append(result, gpuPctInfo{
			Name:   name,
			GpuPct: dev.Activity["GFX"].Value,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// ── /api/limits ──────────────────────────────────────────────────────────────
// Returns ryzenadj limits (power and thermal) from the cached ryzenadj -i output.
// Any field is omitted when ryzenadj is not configured or the value is absent.

type powerLimitsInfo struct {
	STAPMWatts     *float64 `json:"stapm_w,omitempty"`
	FastWatts      *float64 `json:"fast_w,omitempty"`
	SlowWatts      *float64 `json:"slow_w,omitempty"`
	APUSlowWatts   *float64 `json:"apu_slow_w,omitempty"`
	THMCoreCelsius *float64 `json:"thm_core_c,omitempty"`
	THMGFXCelsius  *float64 `json:"thm_gfx_c,omitempty"`
	THMSOCCelsius  *float64 `json:"thm_soc_c,omitempty"`
}

// parseRyzenAdjInfo extracts power and thermal limits from `ryzenadj -i` output.
//
// Modern ryzenadj output uses a leading "|" on every data row:
//   | STAPM LIMIT | 45000 | (bias) | (min) | (max) | mW |
// Older/alternative output may omit the leading "|":
//   stapm_limit | 45000 | mW
//
// Both formats are handled by detecting whether parts[0] is empty.
// The unit is found by scanning all columns after the value.
// Name matching is case-insensitive substring-based.
func parseRyzenAdjInfo(output string) powerLimitsInfo {
	var result powerLimitsInfo
	for _, line := range strings.Split(output, "\n") {
		parts := strings.Split(line, "|")
		if len(parts) < 3 {
			continue
		}
		// Leading "|" makes parts[0] empty — shift past it.
		off := 0
		if strings.TrimSpace(parts[0]) == "" {
			off = 1
		}
		if off+1 >= len(parts) {
			continue
		}
		name   := strings.TrimSpace(parts[off])
		valStr := strings.TrimSpace(parts[off+1])
		if name == "" || name == "Name" {
			continue
		}
		val, err := strconv.ParseFloat(valStr, 64)
		if err != nil || val <= 0 {
			continue
		}
		// Scan remaining columns for the unit.
		unit := ""
		for idx := off + 2; idx < len(parts); idx++ {
			u := strings.ToLower(strings.TrimSpace(parts[idx]))
			if u == "mw" || u == "w" || u == "mdegc" || u == "degc" {
				unit = u
				break
			}
		}
		n := strings.ToLower(name)
		// Require "limit" in the name to avoid matching VALUE rows that appear
		// directly below each LIMIT row in the ryzenadj table.
		if !strings.Contains(n, "limit") {
			continue
		}
		switch {
		case strings.Contains(n, "stapm"):
			if w := toWatts(val, unit); w != nil {
				result.STAPMWatts = w
			}
		case strings.Contains(n, "fast") && strings.Contains(n, "ppt"):
			if w := toWatts(val, unit); w != nil {
				result.FastWatts = w
			}
		case strings.Contains(n, "slow") && strings.Contains(n, "ppt"):
			if w := toWatts(val, unit); w != nil {
				result.SlowWatts = w
			}
		case strings.Contains(n, "apu") && strings.Contains(n, "slow"):
			if w := toWatts(val, unit); w != nil {
				result.APUSlowWatts = w
			}
		case strings.Contains(n, "thm") && strings.Contains(n, "core"):
			if c := toCelsius(val, unit); c != nil {
				result.THMCoreCelsius = c
			}
		case strings.Contains(n, "thm") && strings.Contains(n, "gfx"):
			if c := toCelsius(val, unit); c != nil {
				result.THMGFXCelsius = c
			}
		case strings.Contains(n, "thm") && strings.Contains(n, "soc"):
			if c := toCelsius(val, unit); c != nil {
				result.THMSOCCelsius = c
			}
		}
	}
	return result
}

func toWatts(val float64, unit string) *float64 {
	var w float64
	switch unit {
	case "mw":
		w = val / 1000.0
	case "w":
		w = val
	default:
		if val > 500 {
			w = val / 1000.0
		} else {
			w = val
		}
	}
	return &w
}

func toCelsius(val float64, unit string) *float64 {
	var c float64
	switch unit {
	case "mdegc":
		c = val / 1000.0
	case "degc":
		c = val
	default:
		if val > 1000 {
			c = val / 1000.0
		} else {
			c = val
		}
	}
	return &c
}

// refreshPowerLimits runs ryzenadj and updates the cached result.
// Safe to call concurrently; only one run is meaningful at a time but duplicates are harmless.
func (h *hub) refreshPowerLimits() {
	if len(h.ryzenAdjArgs) == 0 {
		return
	}
	out, err := exec.Command(h.ryzenAdjArgs[0], h.ryzenAdjArgs[1:]...).Output()
	var result powerLimitsInfo
	if err != nil {
		log.Printf("ryzenadj error: %v", err)
	} else {
		result = parseRyzenAdjInfo(string(out))
		if result.STAPMWatts == nil && result.FastWatts == nil && result.SlowWatts == nil {
			log.Printf("ryzenadj: parsed no limits; raw output:\n%s", string(out))
		}
	}
	h.mu.Lock()
	h.powerCache = result
	h.mu.Unlock()
}

func (h *hub) serveLimits(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	result := h.powerCache
	h.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// ── /api/system ──────────────────────────────────────────────────────────────
// System-wide stats not specific to a GPU: memory, uptime, load, and every
// hwmon sensor the kernel exposes. Polled from the browser at low frequency
// (≤ 1 Hz) since these change slowly compared to GPU metrics. Each section is
// best-effort — missing files are simply omitted from the response.

type sysSensor struct {
	Chip  string  `json:"chip"`
	Label string  `json:"label"`
	Value float64 `json:"value"`
}

type systemInfo struct {
	TotalRAMMiB uint64      `json:"total_ram_mib"`
	AvailRAMMiB uint64      `json:"avail_ram_mib"`
	UptimeSec   float64     `json:"uptime_sec"`
	LoadAvg     [3]float64  `json:"loadavg"`
	Fans        []sysSensor `json:"fans"`     // RPM
	Voltages    []sysSensor `json:"voltages"` // mV
	Currents    []sysSensor `json:"currents"` // mA
	Powers      []sysSensor `json:"powers"`   // µW
	Temps       []sysSensor `json:"temps"`    // °C
}

func readFileTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// splitSensorName turns "fan1_input" → ("fan1", "fan"), "in0_input" → ("in0", "in").
func splitSensorName(base string) (prefix, kind string) {
	prefix = strings.TrimSuffix(base, "_input")
	for i := 0; i < len(prefix); i++ {
		if prefix[i] >= '0' && prefix[i] <= '9' {
			return prefix, prefix[:i]
		}
	}
	return prefix, prefix
}

func readHwmon() (fans, volts, currs, pows, temps []sysSensor) {
	dirs, _ := filepath.Glob("/sys/class/hwmon/hwmon*")
	for _, dir := range dirs {
		chip := readFileTrim(filepath.Join(dir, "name"))
		if chip == "" {
			chip = filepath.Base(dir)
		}
		inputs, _ := filepath.Glob(filepath.Join(dir, "*_input"))
		for _, input := range inputs {
			prefix, kind := splitSensorName(filepath.Base(input))
			valStr := readFileTrim(input)
			if valStr == "" {
				continue
			}
			val, err := strconv.ParseFloat(valStr, 64)
			if err != nil {
				continue
			}
			label := readFileTrim(filepath.Join(dir, prefix+"_label"))
			if label == "" {
				label = prefix
			}
			s := sysSensor{Chip: chip, Label: label, Value: val}
			switch kind {
			case "fan":
				fans = append(fans, s)
			case "in":
				volts = append(volts, s)
			case "curr":
				currs = append(currs, s)
			case "power":
				pows = append(pows, s)
			case "temp":
				s.Value = val / 1000 // m°C → °C
				temps = append(temps, s)
			}
		}
	}
	return
}

func readMemInfo() (total, avail uint64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		var dst *uint64
		switch {
		case strings.HasPrefix(line, "MemTotal:"):
			dst = &total
		case strings.HasPrefix(line, "MemAvailable:"):
			dst = &avail
		default:
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if kb, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
			*dst = kb / 1024 // KiB → MiB
		}
	}
	return
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

func serveSystem(w http.ResponseWriter, r *http.Request) {
	fans, volts, currs, pows, temps := readHwmon()
	total, avail := readMemInfo()
	info := systemInfo{
		TotalRAMMiB: total,
		AvailRAMMiB: avail,
		UptimeSec:   readUptime(),
		LoadAvg:     readLoadAvg(),
		Fans:        fans,
		Voltages:    volts,
		Currents:    currs,
		Powers:      pows,
		Temps:       temps,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(info)
}

// ── CPU core performance ranks ────────────────────────────────────────────────

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
		pkgID, hasPkg   := readSysInt(filepath.Join(cpuDir, "topology/physical_package_id"))
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

// ── static files ─────────────────────────────────────────────────────────────

func serveStatic(name, contentType string) http.HandlerFunc {
	data, err := static.ReadFile(name)
	if err != nil {
		panic(err)
	}
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}

// ── main ─────────────────────────────────────────────────────────────────────

func main() {
	// atopweb-specific flags
	port    := flag.Int("port", 5899, "TCP port to listen on")
	atopBin := flag.String("amdgpu-top", "", "path to amdgpu_top binary (default: search PATH)")
	useSudo  := flag.Bool("sudo", false, "launch amdgpu_top via 'sudo -n' (requires a NOPASSWD sudoers entry for the atopweb user)")
	sudoBin    := flag.String("sudo-bin",  "sudo", "path to the sudo binary (NixOS: /run/wrappers/bin/sudo)")
	ryzenAdj   := flag.String("ryzenadj", "",     "path to ryzenadj binary for reading APU power limits")
	procCache  := flag.String("proc-cache", "", "path to JSON file for persistent GPU process name cache (enables early process start detection across restarts); empty = in-memory only")
	useFanotify := flag.Bool("fanotify", false, "use Linux fanotify to watch GPU device nodes for zero-lag process start detection (requires CAP_SYS_ADMIN)")

	// amdgpu_top JSON-mode passthrough flags
	intervalMs := flag.Int("s", 1000, "amdgpu_top refresh period in milliseconds")
	updateIdx  := flag.Int("u", 5, "amdgpu_top fdinfo update interval in seconds")
	instance   := flag.Int("i", -1, "amdgpu_top GPU instance index (default: all)")
	pci        := flag.String("pci", "", "amdgpu_top PCI path: domain:bus:dev.func")
	apu        := flag.Bool("apu", false, "amdgpu_top: select APU instance")
	single     := flag.Bool("single", false, "amdgpu_top: display only the selected GPU")
	nopc       := flag.Bool("no-pc", false, "amdgpu_top: skip GPU performance counter reads")

	flag.Parse()

	log.Printf("atopweb %s starting", version)

	// Log the current process user.
	if u, err := user.Current(); err == nil {
		log.Printf("running as %s (uid %s)", u.Username, u.Uid)
		if u.Uid != "0" && !*useSudo {
			log.Printf("warning: not running as root and --sudo not set — amdgpu_top may lack access to fdinfo, perf counters, and power limits")
		}
	}

	binary := *atopBin
	if binary == "" {
		var err error
		binary, err = exec.LookPath("amdgpu_top")
		if err != nil {
			log.Fatal("amdgpu_top not found on PATH; use --amdgpu-top to specify the path")
		}
	}
	log.Printf("amdgpu_top binary: %s", binary)

	atopVer := getAtopVersion(binary)
	log.Printf("amdgpu_top version: %s", atopVer)

	atopArgs := buildAtopArgs(*updateIdx, *instance, *pci, *apu, *single, *nopc)

	// When --sudo is set, run amdgpu_top as root via sudo. The -n flag makes
	// sudo fail immediately if no NOPASSWD entry exists rather than hanging.
	if *useSudo {
		atopArgs = append([]string{binary}, atopArgs...)
		binary = *sudoBin
		atopArgs = append([]string{"-n"}, atopArgs...)
		log.Printf("amdgpu_top will run via sudo (%s)", *sudoBin)
	}

	log.Printf("amdgpu_top base args: %v (interval injected dynamically)", atopArgs)

	// Build ryzenadj invocation (with sudo prefix when --sudo is set).
	var ryzenAdjArgs []string
	if *ryzenAdj != "" {
		if *useSudo {
			ryzenAdjArgs = []string{*sudoBin, "-n", *ryzenAdj, "-i"}
		} else {
			ryzenAdjArgs = []string{*ryzenAdj, "-i"}
		}
		log.Printf("ryzenadj: %v", ryzenAdjArgs)
	}

	h := &hub{
		clients:      make(map[*websocket.Conn]struct{}),
		intervalMs:   *intervalMs,
		atopVersion:  atopVer,
		ryzenAdjArgs: ryzenAdjArgs,
	}
	go runStreamer(binary, atopArgs, h)

	// GPU process early-detection pipeline.
	gpuCache := loadGPUProcCache(*procCache)
	tracker  := newProcEventTracker()
	go watchKFDProcs(h, tracker)
	go watchKnownGPUProcs(h, gpuCache, tracker)
	go populateGPUProcCache(h, gpuCache)
	if *useFanotify {
		go watchFanotifyGPU(h, tracker, nil)
	}

	go h.refreshPowerLimits() // warm cache at startup
	go func() {
		t := time.NewTicker(15 * time.Minute)
		defer t.Stop()
		for range t.C {
			h.refreshPowerLimits()
		}
	}()

	// Dashboard: log each browser connection and refresh the ryzenadj cache so
	// the /api/limits call the browser makes after loading gets fresh data.
	dashHandler := serveStatic("dashboard.html", "text/html; charset=utf-8")
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		log.Printf("dashboard opened from %s", r.RemoteAddr)
		go h.refreshPowerLimits()
		dashHandler(w, r)
	})
	http.HandleFunc("/dashboard.css", serveStatic("dashboard.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard.js",  serveStatic("dashboard.js",  "application/javascript; charset=utf-8"))
	http.HandleFunc("/api/config",       h.serveConfig)
	http.HandleFunc("/api/interval",     h.serveSetInterval)
	http.HandleFunc("/api/vram",         h.serveVRAM)
	http.HandleFunc("/api/gpu-pct",      h.serveGPUPct)
	http.HandleFunc("/api/limits",       h.serveLimits)
	http.HandleFunc("/api/system",       serveSystem)
	http.HandleFunc("/api/cpu-ranks",    serveCoreRanks)
	http.HandleFunc("/ws",               h.serveWS)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("listening on http://0.0.0.0%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
