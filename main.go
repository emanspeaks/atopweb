package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"os/user"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

//go:embed VERSION
var versionFile string

var version = strings.TrimSpace(versionFile)

//go:embed dashboard.html dashboard-base.css dashboard-header.css dashboard-cards.css dashboard-charts.css dashboard-process.css dashboard-overlays.css dashboard-status.css config.js raf.js state.js cache.js dom-helpers.js chart-callbacks.js build-dom.js build-cards.js build-memory-bar.js build-grbm.js build-charts.js build-core-freq.js build-process.js update-device.js update-chart-data.js update-grbm.js update-process.js ws.js device-header.js core-ranks.js system-info.js power-limits.js data-src-tooltip.js settings.js config-fetch.js controls.js status-bar.js overlay.js mem-treemap.js dashboard.js
var static embed.FS

// serveStatic serves an embedded static file with the given content type.
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
	port := flag.Int("port", 5899, "TCP port to listen on")
	atopBin := flag.String("amdgpu-top", "", "path to amdgpu_top binary (default: search PATH)")
	useSudo := flag.Bool("sudo", false, "launch amdgpu_top via 'sudo -n' (requires a NOPASSWD sudoers entry for the atopweb user)")
	sudoBin := flag.String("sudo-bin", "sudo", "path to the sudo binary (NixOS: /run/wrappers/bin/sudo)")
	ryzenAdj := flag.String("ryzenadj", "", "path to ryzenadj binary for reading APU power limits")
	procCache := flag.String("proc-cache", "", "path to JSON file for persistent GPU process name cache (enables early process start detection across restarts); empty = in-memory only")
	useFanotify := flag.Bool("fanotify", false, "use Linux fanotify to watch GPU device nodes for zero-lag process start detection (requires CAP_SYS_ADMIN)")
	showGttMargin := flag.Bool("show-gtt-margin", false, "show Non-GTT and GTT Margin calculations in the memory bar legend")
	useTop := flag.Bool("use-top", false, "use amdgpu_top JSON mode instead of the default amdgpu-go libdrm bindings (requires amdgpu_top to be installed)")

	// amdgpu_top JSON-mode passthrough flags (ignored unless --use-top is set)
	intervalMs := flag.Int("s", 1000, "amdgpu_top refresh period in milliseconds")
	updateIdx := flag.Int("u", 5, "amdgpu_top fdinfo update interval in seconds")
	instance := flag.Int("i", -1, "amdgpu_top GPU instance index (default: all)")
	pci := flag.String("pci", "", "amdgpu_top PCI path: domain:bus:dev.func")
	apu := flag.Bool("apu", false, "amdgpu_top: select APU instance")
	single := flag.Bool("single", false, "amdgpu_top: display only the selected GPU")
	nopc := flag.Bool("no-pc", false, "skip GPU performance counter reads (GRBM register sampling)")

	flag.Parse()

	log.Printf("atopweb %s starting", version)

	// Log the current process user.
	if u, err := user.Current(); err == nil {
		log.Printf("running as %s (uid %s)", u.Username, u.Uid)
		if u.Uid != "0" && !*useSudo && *useTop {
			log.Printf("warning: not running as root and --sudo not set — amdgpu_top may lack access to fdinfo, perf counters, and power limits")
		}
	}

	var binary string
	var atopVer string
	var atopArgs []string

	if *useTop {
		binary = *atopBin
		if binary == "" {
			var err error
			binary, err = exec.LookPath("amdgpu_top")
			if err != nil {
				log.Fatal("amdgpu_top not found on PATH; use --amdgpu-top to specify the path, or omit --use-top to use the default libdrm backend")
			}
		}
		log.Printf("amdgpu_top binary: %s", binary)

		atopVer = getAtopVersion(binary)
		log.Printf("amdgpu_top version: %s", atopVer)

		atopArgs = buildAtopArgs(*updateIdx, *instance, *pci, *apu, *single, *nopc)

		// When --sudo is set, run amdgpu_top as root via sudo. The -n flag makes
		// sudo fail immediately if no NOPASSWD entry exists rather than hanging.
		if *useSudo {
			atopArgs = append([]string{binary}, atopArgs...)
			binary = *sudoBin
			atopArgs = append([]string{"-n"}, atopArgs...)
			log.Printf("amdgpu_top will run via sudo (%s)", *sudoBin)
		}

		log.Printf("amdgpu_top base args: %v (interval injected dynamically)", atopArgs)
	} else {
		log.Printf("using amdgpu-go libdrm bindings (default); pass --use-top to switch to amdgpu_top JSON mode")
	}

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
		clients:       make(map[*websocket.Conn]struct{}),
		intervalMs:    *intervalMs,
		showGttMargin: *showGttMargin,
		atopVersion:   atopVer,
		ryzenAdjArgs:  ryzenAdjArgs,
		dramMaxBWKiBs: readDRAMMaxBWKiBs(),
	}
	initDRAMBW()
	if *useTop {
		go runStreamer(binary, atopArgs, h)
	} else {
		go runDRMPoller(h, *nopc)
	}
	go runSystemPusher(h)
	go runMemPusher(h)
	go watchShutdownFile(h)
	go watchLogindShutdown(h)

	// GPU process early-detection pipeline.
	gpuCache := loadGPUProcCache(*procCache)
	tracker := newProcEventTracker()
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
	http.HandleFunc("/dashboard-base.css", serveStatic("dashboard-base.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard-header.css", serveStatic("dashboard-header.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard-cards.css", serveStatic("dashboard-cards.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard-charts.css", serveStatic("dashboard-charts.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard-process.css", serveStatic("dashboard-process.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard-overlays.css", serveStatic("dashboard-overlays.css", "text/css; charset=utf-8"))
	http.HandleFunc("/dashboard-status.css", serveStatic("dashboard-status.css", "text/css; charset=utf-8"))
	http.HandleFunc("/config.js", serveStatic("config.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/raf.js", serveStatic("raf.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/state.js", serveStatic("state.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/cache.js", serveStatic("cache.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/dom-helpers.js", serveStatic("dom-helpers.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/chart-callbacks.js", serveStatic("chart-callbacks.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-dom.js", serveStatic("build-dom.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-cards.js", serveStatic("build-cards.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-memory-bar.js", serveStatic("build-memory-bar.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-grbm.js", serveStatic("build-grbm.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-charts.js", serveStatic("build-charts.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-core-freq.js", serveStatic("build-core-freq.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/build-process.js", serveStatic("build-process.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/update-device.js", serveStatic("update-device.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/update-chart-data.js", serveStatic("update-chart-data.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/update-grbm.js", serveStatic("update-grbm.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/update-process.js", serveStatic("update-process.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/ws.js", serveStatic("ws.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/device-header.js", serveStatic("device-header.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/core-ranks.js", serveStatic("core-ranks.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/system-info.js", serveStatic("system-info.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/power-limits.js", serveStatic("power-limits.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/data-src-tooltip.js", serveStatic("data-src-tooltip.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/settings.js", serveStatic("settings.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/config-fetch.js", serveStatic("config-fetch.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/controls.js", serveStatic("controls.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/status-bar.js", serveStatic("status-bar.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/overlay.js", serveStatic("overlay.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/mem-treemap.js", serveStatic("mem-treemap.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/dashboard.js", serveStatic("dashboard.js", "application/javascript; charset=utf-8"))
	http.HandleFunc("/api/config", h.serveConfig)
	http.HandleFunc("/api/interval", h.serveSetInterval)
	http.HandleFunc("/api/vram", h.serveVRAM)
	http.HandleFunc("/api/gpu-pct", h.serveGPUPct)
	http.HandleFunc("/api/limits", h.serveLimits)
	http.HandleFunc("/api/system", serveSystem)
	http.HandleFunc("/api/cpu-ranks", serveCoreRanks)
	http.HandleFunc("/ws", h.serveWS)

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("listening on http://0.0.0.0%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
