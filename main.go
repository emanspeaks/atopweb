package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var version = "dev"

//go:embed dashboard.html dashboard.css dashboard.js
var static embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

type hub struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]struct{}
	last    []byte
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

func runStreamer(binary string, atopArgs []string, h *hub) {
	for {
		cmd := exec.Command(binary, atopArgs...)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("pipe: %v; retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			log.Printf("start amdgpu_top: %v; retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}
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
		cmd.Wait()
		log.Printf("amdgpu_top exited; retrying in 5s")
		time.Sleep(5 * time.Second)
	}
}

func buildAtopArgs(intervalMs, updateIdx, instance int, pci string, apu, single, nopc bool) []string {
	args := []string{
		"-J",
		"-s", strconv.Itoa(intervalMs),
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
// GfxPct maps to gpu_activity.GFX, which corresponds to the amdgpu driver's gpu_busy_percent
// (the same value most GPU monitors display as the primary GPU-usage percentage).

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

// ── /api/power-limits ────────────────────────────────────────────────────────
// Returns APU package power limits in watts:
//   stapm_w  – from gpu_metrics in the last frame (milliwatts → W)
//   fast_w   – RAPL constraint_1 short_term (µW → W)
//   slow_w   – RAPL constraint_0 long_term  (µW → W)
// Any field is omitted when the source is unavailable.

type powerLimitsInfo struct {
	STAPMWatts *float64 `json:"stapm_w,omitempty"`
	FastWatts  *float64 `json:"fast_w,omitempty"`
	SlowWatts  *float64 `json:"slow_w,omitempty"`
}

// readUW reads a sysfs file containing a power value in microwatts and
// returns it converted to watts, or nil on any error.
func readUW(path string) *float64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(string(data)), 64)
	if err != nil || v <= 0 {
		return nil
	}
	w := v / 1e6
	return &w
}

// raplConstraintUW tries several known sysfs base paths for the RAPL
// powercap interface and returns the value of the requested constraint
// file, converted from µW to W.
func raplConstraintW(constraintFile string) *float64 {
	bases := []string{
		"/sys/class/powercap/intel-rapl:0",
		"/sys/devices/virtual/powercap/intel-rapl/intel-rapl:0",
	}
	for _, base := range bases {
		if v := readUW(base + "/" + constraintFile); v != nil {
			return v
		}
	}
	return nil
}

func (h *hub) servePowerLimits(w http.ResponseWriter, r *http.Request) {
	result := powerLimitsInfo{
		FastWatts: raplConstraintW("constraint_1_power_limit_uw"),
		SlowWatts: raplConstraintW("constraint_0_power_limit_uw"),
	}

	// STAPM from the most recent streaming frame (milliwatts → W).
	h.mu.Lock()
	raw := h.last
	h.mu.Unlock()

	if raw != nil {
		var frame atopFrame
		if err := json.Unmarshal(raw, &frame); err == nil {
			for _, dev := range frame.Devices {
				if mw := dev.GPUMetrics.STAPMPowerLimit; mw != nil && *mw > 0 {
					w := *mw / 1000.0
					result.STAPMWatts = &w
					break
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(result)
}

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

func main() {
	// atopweb-specific flags
	port    := flag.Int("port", 5899, "TCP port to listen on")
	atopBin := flag.String("amdgpu-top", "", "path to amdgpu_top binary (default: search PATH)")

	// amdgpu_top JSON-mode passthrough flags
	intervalMs := flag.Int("s", 1000, "amdgpu_top refresh period in milliseconds")
	updateIdx  := flag.Int("u", 5, "amdgpu_top fdinfo update interval in seconds")
	instance   := flag.Int("i", -1, "amdgpu_top GPU instance index (default: all)")
	pci        := flag.String("pci", "", "amdgpu_top PCI path: domain:bus:dev.func")
	apu        := flag.Bool("apu", false, "amdgpu_top: select APU instance")
	single     := flag.Bool("single", false, "amdgpu_top: display only the selected GPU")
	nopc       := flag.Bool("no-pc", false, "amdgpu_top: skip GPU performance counter reads")

	flag.Parse()

	binary := *atopBin
	if binary == "" {
		var err error
		binary, err = exec.LookPath("amdgpu_top")
		if err != nil {
			log.Fatal("amdgpu_top not found on PATH; use --amdgpu-top to specify the path")
		}
	}

	atopArgs := buildAtopArgs(*intervalMs, *updateIdx, *instance, *pci, *apu, *single, *nopc)
	log.Printf("atopweb %s — running: %s %v", version, binary, atopArgs)

	h := &hub{clients: make(map[*websocket.Conn]struct{})}
	go runStreamer(binary, atopArgs, h)

	http.HandleFunc("/", serveStatic("dashboard.html", "text/html; charset=utf-8"))
	http.HandleFunc("/dashboard.css", serveStatic("dashboard.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard.js", serveStatic("dashboard.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/api/vram", h.serveVRAM)
	http.HandleFunc("/api/gpu-pct", h.serveGPUPct)
	http.HandleFunc("/api/power-limits", h.servePowerLimits)
	http.HandleFunc("/ws", h.serveWS)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("listening on http://0.0.0.0%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
