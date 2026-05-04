package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os/exec"
	"os/user"
	"time"

	"github.com/gorilla/websocket"
)

// version is overridden at release build time via -ldflags="-X main.version=vX.Y.Z".
var version = "dev"

//go:embed web
var webFS embed.FS

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
	useTop := flag.Bool("use-top", !drmAvailable, "use amdgpu_top JSON mode instead of the default amdgpu-go libdrm bindings (requires amdgpu_top to be installed)")
	legacyFront := flag.Bool("legacy-front", false, "serve the v1.6.11 legacy frontend instead of the current one")

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

	// Serve embedded web assets.
	if *legacyFront {
		log.Printf("serving legacy (v1.6.11) frontend")
		legacySub, err := fs.Sub(webFS, "web/legacy")
		if err != nil {
			log.Fatal(err)
		}
		legacyServer := http.FileServer(http.FS(legacySub))
		http.Handle("/dashboard.css", legacyServer)
		http.Handle("/dashboard.js", legacyServer)
	} else {
		sub, err := fs.Sub(webFS, "web")
		if err != nil {
			log.Fatal(err)
		}
		fileServer := http.FileServer(http.FS(sub))
		http.Handle("/js/", fileServer)
		http.Handle("/css/", fileServer)
	}

	// Dashboard: log each browser connection and refresh the ryzenadj cache so
	// the /api/limits call the browser makes after loading gets fresh data.
	dashPath := "web/dashboard.html"
	if *legacyFront {
		dashPath = "web/legacy/dashboard.html"
	}
	dashBytes, err := webFS.ReadFile(dashPath)
	if err != nil {
		log.Fatal(err)
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		log.Printf("dashboard opened from %s", r.RemoteAddr)
		go h.refreshPowerLimits()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(dashBytes)
	})
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
