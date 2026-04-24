package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/binary"
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
	mu                 sync.Mutex
	clients            map[*websocket.Conn]struct{}
	last               []byte
	intervalMs         int
	cancelFn           context.CancelFunc
	atopVersion        string          // amdgpu_top version string
	ryzenAdjArgs       []string        // nil if not configured; includes sudo prefix when needed
	powerCache         powerLimitsInfo // last successful ryzenadj result
	limitsRefreshedAt  time.Time       // when powerCache was last written
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

// pushAll sends msg to all connected clients without updating h.last.
// Used for non-GPU push frames (system info, etc.) so that h.last always
// holds the most recent GPU frame for /api/vram, /api/gpu-pct, and the
// proc-name learning goroutine.
func (h *hub) pushAll(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
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
	IntervalMs      int    `json:"interval_ms"`
	AtopwebVersion  string `json:"atopweb_version"`
	AtopTopVersion  string `json:"amdgpu_top_version"`
	TotalRAMMiB     uint64 `json:"total_ram_mib"`
	KernelVersion   string `json:"kernel_version,omitempty"`
	NixosVersion    string `json:"nixos_version,omitempty"`
	NixosGeneration int    `json:"nixos_generation,omitempty"`
	CPUGovernor     string `json:"cpu_gov,omitempty"`
}

// readCPUGovernor returns the scaling governor of cpu0 — e.g. "performance",
// "powersave", "schedutil", "ondemand". Empty when cpufreq isn't exposed
// (virtualized hosts, non-Linux). cpu0 is representative because Linux
// applies the same governor to every core by default; heterogeneous configs
// would need per-core reporting.
func readCPUGovernor() string {
	return readFileTrim("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor")
}

// readKernelVersion returns the running kernel release string, e.g.
// "6.6.63-nixos". Empty on non-Linux or when /proc is unavailable.
func readKernelVersion() string {
	return strings.TrimSpace(string(mustReadFileOrEmpty("/proc/sys/kernel/osrelease")))
}

func mustReadFileOrEmpty(path string) []byte {
	b, _ := os.ReadFile(path)
	return b
}

// readOsRelease parses /etc/os-release and returns key/value pairs with
// shell-style quotes stripped.
func readOsRelease() map[string]string {
	m := map[string]string{}
	b, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(b), "\n") {
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		k := line[:eq]
		v := strings.Trim(line[eq+1:], `"`)
		m[k] = v
	}
	return m
}

// readNixosInfo returns ("25.05", 42) on NixOS, or ("", 0) elsewhere.
// Generation comes from the target of /nix/var/nix/profiles/system, which is
// set to "system-<N>-link" after every `nixos-rebuild switch` / `boot`.
func readNixosInfo() (version string, generation int) {
	osr := readOsRelease()
	if osr["ID"] != "nixos" {
		return "", 0
	}
	version = osr["VERSION_ID"]
	if version == "" {
		version = osr["VERSION"]
	}
	if target, err := os.Readlink("/nix/var/nix/profiles/system"); err == nil {
		name := strings.TrimPrefix(strings.TrimSuffix(target, "-link"), "system-")
		if n, err := strconv.Atoi(name); err == nil {
			generation = n
		}
	}
	return version, generation
}

func (h *hub) serveConfig(w http.ResponseWriter, r *http.Request) {
	mem := readMemInfoAll()
	total := mem["MemTotal"] / 1024
	nixosVer, nixosGen := readNixosInfo()
	h.mu.Lock()
	info := configInfo{
		IntervalMs:      h.intervalMs,
		AtopwebVersion:  version,
		AtopTopVersion:  h.atopVersion,
		TotalRAMMiB:     total,
		KernelVersion:   readKernelVersion(),
		NixosVersion:    nixosVer,
		NixosGeneration: nixosGen,
		CPUGovernor:     readCPUGovernor(),
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
	h.limitsRefreshedAt = time.Now()
	h.mu.Unlock()
}

func (h *hub) serveLimits(w http.ResponseWriter, r *http.Request) {
	// Refresh cache if stale (>30 s) so the client always gets current ryzenadj values.
	h.mu.Lock()
	stale := len(h.ryzenAdjArgs) > 0 && time.Since(h.limitsRefreshedAt) > 30*time.Second
	h.mu.Unlock()
	if stale {
		h.refreshPowerLimits()
	}

	h.mu.Lock()
	result := h.powerCache
	h.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

// ── /api/system + WebSocket system pusher ────────────────────────────────────
// System-wide stats not specific to a GPU: memory, uptime, load, and every
// hwmon sensor the kernel exposes.  The HTTP endpoint is kept for tooling;
// the primary delivery path is runSystemPusher, which pushes a typed WS frame
// at 1 Hz so browsers receive updates even when the tab is backgrounded
// (setInterval is throttled in background tabs; WS message events are not).

type sysSensor struct {
	Chip  string  `json:"chip"`
	Label string  `json:"label"`
	Value float64 `json:"value"`
}

type systemInfo struct {
	TotalRAMMiB         uint64            `json:"total_ram_mib"`
	AvailRAMMiB         uint64            `json:"avail_ram_mib"`
	MemInfoKB           map[string]uint64 `json:"meminfo_kb,omitempty"`            // all /proc/meminfo fields in kB
	FirmwareReservedMiB uint64            `json:"firmware_reserved_mib,omitempty"` // DRAM reserved above top-of-System-RAM (includes BIOS VRAM carveout; JS subtracts it).  Byte-exact when MSRs available, else e820 estimate.
	MemReservation      memReservation    `json:"mem_reservation,omitempty"`       // full authoritative memory-topology report (TOP_MEM, TOP_MEM2, TSEG, etc.)
	DRMMem              *drmAccounting    `json:"drm_mem,omitempty"`               // per-process DRM memory breakdown from /proc/*/fdinfo
	SockMemKB           uint64            `json:"sock_mem_kb,omitempty"`           // kernel network-stack page allocations (sum of /proc/net/sockstat "mem" lines × page size)
	DmaBufBytes         uint64            `json:"dma_buf_bytes,omitempty"`         // total dma-buf bytes across all exporters (informational; overlaps with VRAM/GTT)
	Errors              []string          `json:"errors,omitempty"`                // sticky non-fatal diagnostics (permissions, missing modules, etc.); each unique message appears once
	ShutdownPending     string            `json:"shutdown_pending,omitempty"`      // non-empty when systemd has a shutdown/reboot scheduled; value is human-readable (e.g. "reboot in 30s")
	UptimeSec           float64           `json:"uptime_sec"`
	LoadAvg     [3]float64        `json:"loadavg"`
	Fans        []sysSensor       `json:"fans"`           // RPM
	Voltages    []sysSensor       `json:"voltages"`       // mV
	Currents    []sysSensor       `json:"currents"`       // mA
	Powers      []sysSensor       `json:"powers"`         // µW
	Temps       []sysSensor       `json:"temps"`          // °C
	CPUUsagePct *float64          `json:"cpu_usage_pct,omitempty"` // 0–100; absent on first tick
}

// cpuStat holds the raw tick counters from the aggregate "cpu" line in /proc/stat.
type cpuStat struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

func (s cpuStat) total() uint64 {
	return s.user + s.nice + s.system + s.idle + s.iowait + s.irq + s.softirq + s.steal
}

// readCPUStat reads the first "cpu" line from /proc/stat.
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

func readMemInfoAll() map[string]uint64 {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return nil
	}
	m := make(map[string]uint64)
	for _, line := range strings.Split(string(data), "\n") {
		idx := strings.IndexByte(line, ':')
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		fields := strings.Fields(line[idx+1:])
		if len(fields) == 0 {
			continue
		}
		if v, err := strconv.ParseUint(fields[0], 10, 64); err == nil {
			m[key] = v // raw value (kB for most fields, plain count for HugePages_*)
		}
	}
	return m
}

// diagnostics collects non-fatal error messages from the privileged readers
// (MSR, DRM fdinfo, debugfs) and deduplicates them by message text.  Each
// unique message is emitted once to the process's stderr via log.Printf (so
// systemd captures it to the journal / syslog) and surfaced in every
// systemInfo response via the Errors field so the dashboard's log pane can
// show it to the user.  The sticky list is never cleared — a given failure
// mode is a configuration problem, not a transient event.
type diagnostics struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	items []string
}

var diag diagnostics

func (d *diagnostics) report(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[msg]; ok {
		return
	}
	if d.seen == nil {
		d.seen = make(map[string]struct{})
	}
	d.seen[msg] = struct{}{}
	d.items = append(d.items, msg)
	log.Printf("atopweb diagnostic: %s", msg)
}

func (d *diagnostics) snapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.items) == 0 {
		return nil
	}
	out := make([]string, len(d.items))
	copy(out, d.items)
	return out
}

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
	msrAMDTopMem   uint32 = 0xC001001A // Low DRAM boundary (end of 0–4 GiB DRAM range)
	msrAMDTopMem2  uint32 = 0xC001001D // Upper DRAM boundary (top of all physical DRAM)
	msrAMDSMMAddr  uint32 = 0xC0010112 // TSEG base (bits 51:17)
	msrAMDSMMMask  uint32 = 0xC0010113 // TSEG mask (bits 51:17) + ASeg/TSeg enables
)

// memReservation is the authoritative memory layout report, derived from
// /sys/firmware/memmap plus (when available) AMD MSRs.  All byte counts are
// exact; *MiB fields are rounded-down MiB for JSON friendliness.
//
// FirmwareReservedMiB captures ALL DRAM reserved by firmware — above top of
// System RAM (typically BIOS VRAM carveout + PSP/SMU/ACPI runtime), inside the
// low-DRAM range (ACPI NVS/Tables, TSEG, small reserved blocks), plus any
// "hidden" bytes below TOP_MEM the firmware didn't advertise in e820 at all.
// VRAM is included in this number; JS subtracts the amdgpu-reported VRAM total
// to derive the non-VRAM portion.
type memReservation struct {
	SystemRAMTopBytes   uint64 `json:"system_ram_top_bytes,omitempty"`  // end-exclusive top of last "System RAM" entry in e820
	SystemRAMMiB        uint64 `json:"system_ram_mib,omitempty"`        // sum of all "System RAM" entries (kernel-addressable DRAM)
	TopMemBytes         uint64 `json:"top_mem_bytes,omitempty"`         // MSR TOP_MEM (low DRAM boundary)
	TopMem2Bytes        uint64 `json:"top_mem2_bytes,omitempty"`        // MSR TOP_MEM2 (upper DRAM boundary)
	TsegBaseBytes       uint64 `json:"tseg_base_bytes,omitempty"`       // SMM_ADDR (TSEG base), 0 if TSEG not enabled
	TsegSizeBytes       uint64 `json:"tseg_size_bytes,omitempty"`       // TSEG size decoded from SMM_MASK
	InstalledMiB        uint64 `json:"installed_mib,omitempty"`         // MSR-derived: TOP_MEM + (TOP_MEM2 - 4 GiB)
	FirmwareReservedMiB uint64 `json:"firmware_reserved_mib,omitempty"` // total DRAM reserved by firmware (above-ToM + low-memory + hidden gap; includes VRAM)
	FirmwareHighMiB     uint64 `json:"firmware_high_mib,omitempty"`     // DRAM reserved above top of System RAM (VRAM carveout + PSP/SMU/runtime)
	FirmwareLowMiB      uint64 `json:"firmware_low_mib,omitempty"`      // DRAM reserved below TOP_MEM (ACPI NVS/Tables, TSEG, small reserved) + any e820 gap
	SourceMSR           bool   `json:"source_msr,omitempty"`            // true if the above numbers used AMD MSRs (byte-exact); false if e820-only fallback
}

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
		memReservationVal.SystemRAMMiB = sysRAMBytes / (1024 * 1024)

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
			memReservationVal.InstalledMiB = (tom + (tom2 - fourGiB)) / (1024 * 1024)
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

		memReservationVal.FirmwareHighMiB = highBytes / (1024 * 1024)
		memReservationVal.FirmwareLowMiB = (lowBytes + hiddenBytes) / (1024 * 1024)
		memReservationVal.FirmwareReservedMiB = (highBytes + lowBytes + hiddenBytes) / (1024 * 1024)

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

var (
	memReservationOnce sync.Once
	memReservationVal  memReservation
)

// drmProcessMem is one per-process DRM memory snapshot derived from
// /proc/<pid>/fdinfo/<fd> for every DRM file descriptor a process holds.
// Values are KiB (matching the fdinfo wire format) and per-process aggregates
// across all of that process's DRM FDs.
type drmProcessMem struct {
	PID        int    `json:"pid"`
	Comm       string `json:"comm,omitempty"`
	Driver     string `json:"driver,omitempty"`      // e.g. "amdgpu"
	VramKiB    uint64 `json:"vram_kib,omitempty"`    // drm-memory-vram
	GttKiB     uint64 `json:"gtt_kib,omitempty"`     // drm-memory-gtt
	CpuKiB     uint64 `json:"cpu_kib,omitempty"`     // drm-memory-cpu  (system-RAM pinned by the driver)
	VisVramKiB uint64 `json:"vis_vram_kib,omitempty"` // amd-memory-visible-vram
}

// drmAccounting bundles everything we know about graphics-subsystem memory
// from three sources:
//   1. /proc/<pid>/fdinfo/<fd>                   — per-process DRM usage
//   2. /sys/class/drm/card*/device/mem_info_*    — kernel-authoritative per-GPU
//      totals (VRAM total/used, CPU-visible VRAM, GTT)
//   3. /sys/kernel/debug/dma_buf/bufinfo         — dma-buf allocations
//
// Fields ending *MiB come from (2); Total*KiB come from (1).  DmaBufBytes is
// separate because dma-bufs can be backed by VRAM, GTT, or system memory — we
// report it informationally, not as an accounting line.
type drmAccounting struct {
	VramTotalMiB    uint64          `json:"vram_total_mib,omitempty"`
	VramUsedMiB     uint64          `json:"vram_used_mib,omitempty"`
	VisVramTotalMiB uint64          `json:"vis_vram_total_mib,omitempty"`
	VisVramUsedMiB  uint64          `json:"vis_vram_used_mib,omitempty"`
	GttTotalMiB     uint64          `json:"gtt_total_mib,omitempty"`
	GttUsedMiB      uint64          `json:"gtt_used_mib,omitempty"`
	TotalVramKiB    uint64          `json:"total_vram_kib,omitempty"`     // sum of per-fd drm-memory-vram
	TotalGttKiB     uint64          `json:"total_gtt_kib,omitempty"`      // sum of per-fd drm-memory-gtt
	TotalCpuKiB     uint64          `json:"total_cpu_kib,omitempty"`      // sum of per-fd drm-memory-cpu — system RAM pinned by DRM drivers
	Processes       []drmProcessMem `json:"processes,omitempty"`
}

// readDRMSysfs pulls authoritative per-GPU memory totals from
// /sys/class/drm/card*/device/mem_info_*.  These are populated by the amdgpu
// kernel driver and are byte-exact.  Multiple cards are summed.  Files that
// don't exist (non-amdgpu GPUs, older kernels) are silently skipped.
func readDRMSysfs(a *drmAccounting) {
	cards, _ := filepath.Glob("/sys/class/drm/card[0-9]*")
	for _, c := range cards {
		// Skip connectors (card1-DP-1 etc.) — only the card root has mem_info.
		if strings.Contains(filepath.Base(c), "-") {
			continue
		}
		readUint := func(name string) uint64 {
			v, _ := strconv.ParseUint(readFileTrim(filepath.Join(c, "device", name)), 10, 64)
			return v
		}
		const toMiB = 1024 * 1024
		a.VramTotalMiB += readUint("mem_info_vram_total") / toMiB
		a.VramUsedMiB += readUint("mem_info_vram_used") / toMiB
		a.VisVramTotalMiB += readUint("mem_info_vis_vram_total") / toMiB
		a.VisVramUsedMiB += readUint("mem_info_vis_vram_used") / toMiB
		a.GttTotalMiB += readUint("mem_info_gtt_total") / toMiB
		a.GttUsedMiB += readUint("mem_info_gtt_used") / toMiB
	}
}

// readDRMFdinfo walks /proc/<pid>/fd and, for every symlink pointing at
// /dev/dri/*, parses the matching /proc/<pid>/fdinfo/<fd> for drm-memory-*
// lines.  Per-process totals are accumulated across all of that PID's DRM FDs.
//
// Requires CAP_SYS_PTRACE (or matching uid) to read fdinfo of processes not
// owned by the current user; missing permission is swallowed silently so the
// scanner just reports what it can see.
func readDRMFdinfo(a *drmAccounting) {
	procs, _ := filepath.Glob("/proc/[0-9]*")
	byPID := make(map[int]*drmProcessMem, 16)
	var permDenied int
	for _, procDir := range procs {
		pidStr := filepath.Base(procDir)
		pid, err := strconv.Atoi(pidStr)
		if err != nil {
			continue
		}
		fdDir := filepath.Join(procDir, "fd")
		entries, err := os.ReadDir(fdDir)
		if err != nil {
			if os.IsPermission(err) {
				permDenied++
			}
			continue
		}
		for _, ent := range entries {
			target, err := os.Readlink(filepath.Join(fdDir, ent.Name()))
			if err != nil || !strings.HasPrefix(target, "/dev/dri/") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(procDir, "fdinfo", ent.Name()))
			if err != nil {
				continue
			}
			p := byPID[pid]
			if p == nil {
				p = &drmProcessMem{PID: pid, Comm: readFileTrim(filepath.Join(procDir, "comm"))}
				byPID[pid] = p
			}
			// Each fdinfo line is "key:\tvalue [KiB]".  Parse the relevant
			// subset; amdgpu emits the amd-memory-* variants alongside the
			// standard drm-memory-* lines.
			for _, line := range strings.Split(string(data), "\n") {
				colon := strings.IndexByte(line, ':')
				if colon < 0 {
					continue
				}
				key := strings.TrimSpace(line[:colon])
				valStr := strings.TrimSpace(line[colon+1:])
				parseKiB := func() uint64 {
					f := strings.Fields(valStr)
					if len(f) == 0 {
						return 0
					}
					v, _ := strconv.ParseUint(f[0], 10, 64)
					return v
				}
				switch key {
				case "drm-driver":
					if p.Driver == "" {
						p.Driver = valStr
					}
				case "drm-memory-vram":
					p.VramKiB += parseKiB()
				case "drm-memory-gtt":
					p.GttKiB += parseKiB()
				case "drm-memory-cpu":
					p.CpuKiB += parseKiB()
				case "amd-memory-visible-vram":
					p.VisVramKiB += parseKiB()
				}
			}
		}
	}
	for _, p := range byPID {
		if p.VramKiB == 0 && p.GttKiB == 0 && p.CpuKiB == 0 {
			continue // xorg/wayland holding a DRM fd with no BOs — skip
		}
		a.TotalVramKiB += p.VramKiB
		a.TotalGttKiB += p.GttKiB
		a.TotalCpuKiB += p.CpuKiB
		a.Processes = append(a.Processes, *p)
	}
	// Sort biggest first for UI convenience.
	sort.Slice(a.Processes, func(i, j int) bool {
		ai := a.Processes[i].VramKiB + a.Processes[i].GttKiB + a.Processes[i].CpuKiB
		aj := a.Processes[j].VramKiB + a.Processes[j].GttKiB + a.Processes[j].CpuKiB
		return ai > aj
	})
	if permDenied > 0 {
		diag.report("DRM fdinfo scan: permission denied on /proc/*/fd — per-process DRM memory totals are incomplete until the service gains CAP_SYS_PTRACE")
	}
}

// readDRMAccounting assembles the full per-GPU + per-process report.
func readDRMAccounting() *drmAccounting {
	a := &drmAccounting{}
	readDRMSysfs(a)
	readDRMFdinfo(a)
	if a.VramTotalMiB == 0 && len(a.Processes) == 0 {
		return nil
	}
	return a
}

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

var readDmaBufErrOnce sync.Once

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

// checkShutdownPending reads /run/systemd/shutdown/scheduled and returns a
// human-readable message when systemd has a shutdown, reboot, halt, or power-
// off queued.  The file is world-readable (no CAP required) and is written
// immediately when any of the following are invoked:
//   - sudo reboot / sudo shutdown / sudo halt / sudo poweroff
//   - systemctl reboot / poweroff / halt / kexec (including via ACPI/power-btn)
//
// Returns "" when no shutdown is pending or the file does not exist.
func checkShutdownPending() string {
	data, err := os.ReadFile("/run/systemd/shutdown/scheduled")
	if err != nil {
		return ""
	}
	var mode string
	var usec int64
	for _, line := range strings.Split(string(data), "\n") {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(k) {
		case "MODE":
			mode = strings.TrimSpace(v)
		case "USEC":
			usec, _ = strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		}
	}
	if mode == "" {
		return ""
	}
	when := time.UnixMicro(usec)
	remaining := time.Until(when).Truncate(time.Second)
	if remaining > 0 {
		return fmt.Sprintf("%s scheduled in %s (at %s)", mode, remaining, when.Format("15:04:05"))
	}
	return fmt.Sprintf("%s in progress (scheduled for %s)", mode, when.Format("15:04:05"))
}

func buildSystemInfo() systemInfo {
	fans, volts, currs, pows, temps := readHwmon()
	memInfo := readMemInfoAll()
	memRes := readMemReservation()
	return systemInfo{
		TotalRAMMiB:         memInfo["MemTotal"] / 1024,
		AvailRAMMiB:         memInfo["MemAvailable"] / 1024,
		MemInfoKB:           memInfo,
		FirmwareReservedMiB: memRes.FirmwareReservedMiB,
		MemReservation:      memRes,
		DRMMem:              readDRMAccounting(),
		SockMemKB:           readSockMemKB(),
		DmaBufBytes:         readDmaBufBytes(),
		Errors:              diag.snapshot(),
		ShutdownPending:     checkShutdownPending(),
		UptimeSec:           readUptime(),
		LoadAvg:     readLoadAvg(),
		Fans:        fans,
		Voltages:    volts,
		Currents:    currs,
		Powers:      pows,
		Temps:       temps,
	}
}

func serveSystem(w http.ResponseWriter, r *http.Request) {
	info := buildSystemInfo()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(info)
}

// wsSysFrame is the WebSocket envelope for server-pushed system data.
// The "type" field lets the client dispatcher route it before the GPU-frame path.
type wsSysFrame struct {
	Type string `json:"type"`
	systemInfo
}

// runSystemPusher pushes a system-info frame over the WebSocket to all
// connected clients once per second.  It uses pushAll (not broadcast) so
// h.last always holds the last GPU frame.
func runSystemPusher(h *hub) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var prevCPU cpuStat
	hasPrevCPU := false
	for range ticker.C {
		info := buildSystemInfo()
		curr, ok := readCPUStat()
		if ok {
			if hasPrevCPU && curr.total() > prevCPU.total() {
				dt := curr.total() - prevCPU.total()
				idleDelta := (curr.idle + curr.iowait) - (prevCPU.idle + prevCPU.iowait)
				if idleDelta <= dt {
					pct := float64(dt-idleDelta) / float64(dt) * 100
					info.CPUUsagePct = &pct
				}
			}
			prevCPU = curr
			hasPrevCPU = true
		}
		frame := wsSysFrame{Type: "system", systemInfo: info}
		b, err := json.Marshal(frame)
		if err != nil {
			continue
		}
		h.pushAll(b)
	}
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
	go runSystemPusher(h)
	go watchShutdownFile(h)

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
