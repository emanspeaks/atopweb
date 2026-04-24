# atopweb

Live AMD GPU / NPU web dashboard powered by [amdgpu_top](https://github.com/Umio-Yasuno/amdgpu_top).

`atopweb` is a small Go binary that runs `amdgpu_top` in JSON streaming mode,
forwards each update over a WebSocket, and serves a browser dashboard at a
configurable HTTP port.

---

## Dashboard

The browser UI updates in real time and shows:

**Stat cards** — three always-visible "system" cards (Fan Speed, Package
Power Tracking, Uptime) followed by per-GPU cards for GFX activity, media
activity, combined VRAM+GTT usage, VRAM usage, GTT usage, CPU usage, SCLK,
MCLK, FCLK, average power, edge temperature, CPU Tctl, VDDGFX, VDDNB. Per-GPU
cards auto-hide when their sensor stays idle so empty fields don't clutter
the layout; they reappear automatically when data returns.

**Memory overview bar** — a full-width, to-scale bar that partitions every
byte of installed DRAM into named, non-overlapping buckets.  Every segment
size comes from an authoritative source; no segment is an unexplained
"Other".

- **VRAM** (BIOS carveout) — free, CPU-invisible used (GPU-only), and
  CPU-visible used (reachable through the PCIe BAR).  Split read from
  `/sys/class/drm/card*/device/mem_info_vis_vram_*`.
- **System RAM** (everything that lives in `MemTotal`) — in left-to-right
  bar order: GTT, DRM-CPU (Σ `drm-memory-cpu` across all `/proc/*/fdinfo`
  DRM FDs), Apps (`AnonPages`), Shared (`Shmem`), File Cache
  (`Cached − Shmem`), Buffers, Slab Reclaim (`SReclaimable`), Slab Unreclaim
  (`SUnreclaim`), Vmalloc (`VmallocUsed`), Kernel Stack, Page Tables
  (`PageTables + SecPageTables`), Net Buffers (sum of `mem`/`memory` fields
  in `/proc/net/sockstat` × page size), Driver Pages (residual — the
  kernel's direct `alloc_pages()` pool used by DMA-coherent allocations
  and NIC page_pool), and Free.
- **Reserved zone** (right side, never dynamically allocatable) — Kernel-Reserved
  (e820 `System RAM − MemTotal`: crashkernel / initrd / kernel
  image / early-boot reservations) and Firmware (PSP/SMU/ACPI/TSEG + any
  hidden e820 gap, excluding the VRAM carveout which is already its own
  segment).

Byte-exact reconciliation uses AMD MSRs (`TOP_MEM`, `TOP_MEM2`, `SMM_ADDR`,
`SMM_MASK`) read via `/dev/cpu/0/msr` to distinguish DRAM from MMIO above
`TOP_MEM2` and to decode the TSEG size precisely.  There is no approximate
e820-only fallback — summing e820 Reserved entries alone would quietly
over-count by whatever MMIO region AMD firmware places above top-of-DRAM
(~770 MiB on Strix Halo), which was judged worse than showing no number at
all.  If the MSRs are unreadable (the `msr` kernel module is not loaded, or
`/dev/cpu/*/msr` is not accessible) the firmware and kernel-reserved
segments are left blank and a diagnostic is written to the systemd journal
and surfaced in the dashboard log pane as a red error.

The legend shows per-segment GiB values (DQI-colored) plus a summary group
on the right: **Installed** (MSR-authoritative physical total, typically
`TOP_MEM + (TOP_MEM2 − 4 GiB)`), **Non-GTT** (`MemTotal − GTT`), and
**System-Margin** (`Non-GTT − Used-without-GTT`; turns red when negative).
Informational `dma-buf` total from `/sys/kernel/debug/dma_buf/bufinfo` is
shown next to the reserved legends; it isn't rendered as a segment because
dma-bufs are usually backed by VRAM/GTT/shmem and would double-count.

**Charts** (time-based scrolling windows; widths configurable in the header;
idle charts auto-hide the same way cards do):

| Chart | Signals |
| --- | --- |
| Temperature | Edge, CPU Tctl, SoC, GFX, Hotspot, Mem — with ryzenadj THM Core / THM GFX / THM SoC limit lines |
| GPU Activity | GFX %, Memory %, Media % |
| VRAM + GTT | Combined, VRAM-only, GTT-only (GiB) — with VRAM+GTT capacity and total-physical-memory limit lines |
| CPU Core Power | Per-core power (W) for all 16 cores |
| Package Power | PPT, Average Power, CPU Cores, NPU — with ryzenadj STAPM / Fast / Slow / APU Slow limit lines |
| Clocks | SCLK, MCLK, FCLK, FCLK avg, SoC Clk, VCN Clk |
| DRAM Bandwidth | Reads, Writes (MB/s) |
| Voltage | VDDGFX, VDDNB (mV) |
| NPU Tile Activity | Per-tile activity % for all 8 tiles |
| NPU Clocks | NPU Clk, MP-NPU Clk (MHz) |
| NPU Bandwidth | Reads, Writes (MB/s) |

Each chart automatically applies a 20 %-of-data-range grace margin so limit
lines (ryzenadj limits, memory ceilings) are always on-screen even when the
live trace is far below them. Click any chart title to open a full-width
overlay with the same series at higher resolution; Esc or the ✕ closes it.

**Process event overlays** — vertical green/red dashed lines on every chart
mark the start/stop of any GPU or NPU process, labeled with the process
name and PID. Early-detection runs as a three-layer server-side pipeline so that
events typically fire within a few hundred milliseconds of `exec()`:

1. **KFD poll** — watches `/sys/class/kfd/kfd/proc` for ROCm/HIP opens of
   `/dev/kfd`.
2. **Known-process poll** — a learning cache of process names that have
   previously used the GPU (persisted to disk with `--proc-cache`); matches
   new PIDs in `/proc` before they touch the GPU.
3. **Fanotify** (optional, `--fanotify`; requires `CAP_SYS_ADMIN`) — kernel
   notification on any open of `/dev/kfd` or `/dev/dri/render*`, firing
   before any GPU memory is allocated.

All three feed a shared per-PID deduplicator so that the same process only
produces one annotation regardless of which layer saw it first. `fdinfo`-based
detection (from the amdgpu_top stream) acts as a final fallback.

**Per-CPU-core frequency mini-charts** — 16 small charts (2 rows × 8), each
showing the SMU-reported clock alongside the OS scaling governor frequency.
Core labels include performance rank derived from
`/sys/devices/system/cpu/cpu*/acpi_cppc/highest_perf`
(e.g. *Core 3 (Rank 1)*).  Hovering any series in any chart shows the
backing JSON field path in the tooltip.

**GRBM / GRBM2 performance counters** — full counter list with mini bar
indicators; click any counter to expand an inline history chart.

**Process table** — merged GPU + NPU processes with PID, name, VRAM (MiB),
GTT (MiB), GFX %, Compute %, DMA %, Media %, VCN %, VPE %, CPU %, NPU %,
NPU Mem (MiB).

**Header** — page title and connection status on the top line, a subtitle
beneath listing `amdgpu_top` version, Linux kernel release, and (on NixOS)
distribution version and generation number; device info (ASIC name, CU
count, VRAM type / size / bandwidth, peak FP32 TFLOPS, NPU name); ryzenadj
limits summary; and a control cluster with pause button, wall-clock
timestamp, inputs for update interval, plot width, and core-clock plot
width, and a **Memory snapshot** button that copies a CSV of every memory
bar segment value — in raw bytes, organized in sections matching the bar's
zones — to the clipboard for spreadsheet verification.

**Status bar** — a collapsible log strip at the bottom of the page. The
current line shows inline; click to expand an auto-scrolling history of
connection events, interval changes, limit updates, and process starts.

---

## How it works

```text
amdgpu_top -J  →  atopweb  →  WebSocket (/ws)  →  browser dashboard (/)
```

`atopweb` does not contain any GPU driver code.  It shells out to the stock
`amdgpu_top` binary and relays its newline-delimited JSON stream to every
connected browser.  If `amdgpu_top` exits it restarts automatically after 5 s.

When `--ryzenadj` is configured, `atopweb` caches `ryzenadj -i` output
(refreshed at startup, on every page load, and on a 15-minute timer) and
serves it from `/api/limits`.  Limits are overlaid as annotation lines
on the power, temperature, and VRAM charts and summarized in the header.

CPU core performance rankings are read from
`/sys/devices/system/cpu/cpu*/acpi_cppc/highest_perf` at first request and
served from `/api/cpu-ranks`.

Host stats outside the GPU stream are collected in `buildSystemInfo()` and
pushed at 1 Hz as a typed frame (`{"type":"system",…}`) over the same `/ws`
WebSocket that carries the GPU stream, with `/api/system` as a REST fallback
for initial page load.  The payload carries fan/voltage/
current/power/temp readings from every `/sys/class/hwmon` sensor, aggregate
CPU usage from `/proc/stat`, uptime, load average, the full
`/proc/meminfo` map, AMD memory-topology MSR read-outs (TOP_MEM, TOP_MEM2,
SMM_ADDR, SMM_MASK) via `/dev/cpu/*/msr`, a `/sys/firmware/memmap` summary,
per-process DRM memory accounting scanned from `/proc/*/fdinfo`, kernel
socket buffer bytes from `/proc/net/sockstat`, and dma-buf total bytes from
`/sys/kernel/debug/dma_buf/bufinfo`.  The dashboard feeds this into the
system stat cards, the VRAM chart's physical-memory ceiling, the PPT trace
on the Package Power chart, and — most significantly — the full memory
overview bar.

---

## API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | GET | Serves the dashboard HTML |
| `/dashboard.css` | GET | Stylesheet |
| `/dashboard.js` | GET | Dashboard application |
| `/ws` | WS | WebSocket stream — carries two kinds of typed frames: the raw `amdgpu_top` JSON at the configured interval, and a `{"type":"system",…}` frame every 1 s with the full `/api/system` payload |
| `/api/config` | GET | Returns `{"interval_ms", "atopweb_version", "amdgpu_top_version", "total_ram_mib", "kernel_version"}`; on NixOS also `"nixos_version"` and `"nixos_generation"` |
| `/api/interval?ms=N` | POST | Changes the amdgpu_top polling interval to N ms (50–60000); restarts the streamer |
| `/api/vram` | GET | Returns per-device `[{"name", "used_mib", "total_mib", "used_pct"}]` from the last frame |
| `/api/gpu-pct` | GET | Returns per-device `[{"name", "gpu_pct"}]` (GFX activity %) from the last frame |
| `/api/limits` | GET | Returns cached ryzenadj limits: `stapm_w`, `fast_w`, `slow_w`, `apu_slow_w`, `thm_core_c`, `thm_gfx_c`, `thm_soc_c`. Fields are omitted when ryzenadj is not configured or the value is absent |
| `/api/cpu-ranks` | GET | Returns `{"ranks": [...]}` — array indexed by CPU core number, value is performance rank (1 = best) derived from ACPI CPPC `highest_perf`; empty array when CPPC data is unavailable |
| `/api/system` | GET | REST fallback for the initial system snapshot (same payload the WebSocket pushes every second). See **`/api/system` payload** below for the full field list |

### `/api/system` payload

| Field | Description |
| --- | --- |
| `total_ram_mib`, `avail_ram_mib` | `MemTotal` / `MemAvailable` from `/proc/meminfo`, in MiB |
| `uptime_sec`, `loadavg` | `/proc/uptime` and `/proc/loadavg` |
| `fans`, `voltages`, `currents`, `powers`, `temps` | Arrays of `{"chip","label","value"}` collected from every `/sys/class/hwmon/hwmon*`; values in RPM / mV / mA / µW / °C respectively |
| `cpu_usage_pct` | Aggregate CPU utilization `0–100` computed from `/proc/stat` deltas between successive 1 Hz ticks (absent on the very first tick) |
| `meminfo_kb` | Map of every `/proc/meminfo` key to its numeric value (kB for most fields, plain counts for `HugePages_*`) |
| `firmware_reserved_mib` | Total DRAM reserved above top-of-System-RAM including the BIOS VRAM carveout; the dashboard subtracts `VRAM total` to derive the non-VRAM firmware segment |
| `mem_reservation` | Full memory-topology report: `system_ram_mib`, `system_ram_top_bytes`, MSR-derived `top_mem_bytes` / `top_mem2_bytes` / `tseg_base_bytes` / `tseg_size_bytes`, `installed_mib` (= `TOP_MEM + (TOP_MEM2 − 4 GiB)`), and the split `firmware_high_mib` (above top of System RAM) + `firmware_low_mib` (below TOP_MEM + any hidden e820 gap).  `source_msr = true` when the numbers came from AMD MSRs (byte-exact); `false` when the msr module is not loaded and MSRs could not be read |
| `drm_mem` | Per-GPU authoritative totals from `/sys/class/drm/card*/device/mem_info_*` (`vram_total_mib`, `vram_used_mib`, `vis_vram_total_mib`, `vis_vram_used_mib`, `gtt_total_mib`, `gtt_used_mib`) plus aggregated per-process breakdown from `/proc/*/fdinfo/*` (`total_vram_kib`, `total_gtt_kib`, `total_cpu_kib`, and a `processes[]` array with `{pid, comm, driver, vram_kib, gtt_kib, cpu_kib, vis_vram_kib}` per DRM-holding process, the largest first) |
| `sock_mem_kb` | Kernel network-buffer memory: sum of the `mem` / `memory` fields in `/proc/net/sockstat` and `/proc/net/sockstat6`, multiplied by the system page size |
| `dma_buf_bytes` | Total size column from `/sys/kernel/debug/dma_buf/bufinfo` (diagnostic only — dma-bufs are usually backed by VRAM/GTT/shmem so adding this to the bar would double-count) |
| `errors` | Array of sticky server-side diagnostics (missing kernel modules, unexpected permission errors, etc.).  Each unique message appears once per process lifetime; the same list is emitted to the systemd journal via `log.Printf` and surfaced in the dashboard log pane as a red error entry |
| `shutdown_pending` | Non-empty string when systemd has a shutdown or reboot queued — e.g. `"reboot scheduled in 45s (at 17:33:00)"`.  Written within milliseconds of the user running `sudo reboot` or `sudo shutdown`, via an inotify watch on `/run/systemd/shutdown/scheduled`. Empty when no shutdown is pending |

---

## Prerequisites

- Linux with an AMD GPU and the `amdgpu` driver loaded
- `amdgpu_top` available on `$PATH` **or** supplied via `--amdgpu-top`
- `/dev/dri/renderD*` and `/dev/dri/card*` accessible by the running user
  (typically requires membership of the `render` and `video` groups)

---

## Running manually

```bash
# amdgpu_top on PATH
atopweb --port 5899

# explicit binary path
atopweb --amdgpu-top /run/current-system/sw/bin/amdgpu_top --port 5899

# skip performance counters (saves power, loses GRBM/GRBM2 data)
atopweb --no-pc

# faster updates (100 ms)
atopweb -s 100

# run amdgpu_top as root via sudo (required for full fdinfo + perf counters)
atopweb --sudo

# APU power limits overlay on the power and temperature charts
atopweb --sudo --ryzenadj /run/current-system/sw/bin/ryzenadj
```

Then open `http://localhost:5899` in a browser.

---

## All flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port` | `5899` | TCP port to listen on |
| `--amdgpu-top` | *(search PATH)* | Path to the `amdgpu_top` binary |
| `--sudo` | `false` | Launch `amdgpu_top` (and `ryzenadj`) via `sudo -n` (for non-root deployments that use a NOPASSWD sudoers entry instead of running atopweb as root) |
| `--sudo-bin` | `sudo` | Path to the sudo binary (NixOS: `/run/wrappers/bin/sudo`) |
| `--ryzenadj` | | Path to `ryzenadj`; when set, polls `ryzenadj -i` for APU power and thermal limits |
| `-s <ms>` | `1000` | amdgpu_top refresh period in milliseconds |
| `-u <sec>` | `5` | amdgpu_top fdinfo update interval in seconds |
| `-i <idx>` | *(all)* | Select a single GPU by instance index |
| `--pci <addr>` | | Select GPU by PCI address (`domain:bus:dev.func`) |
| `--apu` | `false` | Select APU instance |
| `--single` | `false` | Display only the selected GPU |
| `--no-pc` | `false` | Skip GPU performance counter reads |
| `--proc-cache <path>` | | Path to a JSON file used as a persistent cache of process names that have previously touched the GPU. When set, enables early-detection of known processes across service restarts. Empty = in-memory only |
| `--fanotify` | `false` | Enable the fanotify-based GPU device watcher for zero-lag process-start detection (requires root or `CAP_SYS_ADMIN`; falls back silently when unavailable) |

---

## NixOS

### Step 1 — generate `gomod2nix.toml`

After cloning, run the gomod2nix workflow manually (Settings → Actions →
*Update gomod2nix.toml* → *Run workflow*), **or** run locally:

```bash
go mod tidy
nix run github:nix-community/gomod2nix -- generate
```

Commit `gomod2nix.toml` before running `nix build`.  The
`.github/workflows/gomod2nix.yml` workflow keeps it up to date automatically
whenever `go.mod` changes.

### Step 2 — add to your system flake

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    atopweb.url = "github:emanspeaks/atopweb";
  };

  outputs = { self, nixpkgs, atopweb, ... }: {
    nixosConfigurations.myhostname = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        ./configuration.nix
        atopweb.nixosModules.default
        {
          services.atopweb = {
            enable       = true;
            port         = 5899;         # optional
            sudo         = true;         # run amdgpu_top as root via sudo
            ryzenAdjBin  = "${pkgs.ryzenadj}/bin/ryzenadj";  # APU power/thermal limits
            fanotify     = true;         # zero-lag process start detection
            # gpuProcCache = true;       # persist learned process names (on by default)
            # nopc       = true;         # skip perf counters
            # interval   = 100;          # 100 ms updates
          };
        }
      ];
    };
  };
}
```

### Step 3 — deploy

```bash
nixos-rebuild switch --flake .#myhostname
```

### Step 4 — open the dashboard

```text
http://<server-ip>:5899
```

---

## NixOS module options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `services.atopweb.enable` | `bool` | `false` | Enable the service |
| `services.atopweb.port` | `port` | `5899` | TCP port |
| `services.atopweb.sudo` | `bool` | `false` | Run `amdgpu_top` (and `ryzenadj`) via `sudo -n`; automatically adds a NOPASSWD sudoers rule for the `atopweb` user |
| `services.atopweb.nopc` | `bool` | `false` | Skip perf counter reads |
| `services.atopweb.interval` | `int` | `1000` | Refresh period in ms |
| `services.atopweb.amdgpuTopBin` | `str` | nix store | `amdgpu_top` binary path |
| `services.atopweb.ryzenAdjBin` | `str` | `""` | `ryzenadj` binary path; when set, polls for APU power and thermal limits and adds a NOPASSWD sudoers rule |
| `services.atopweb.gpuProcCache` | `bool` | `true` | Persist the GPU process-name learning cache in `/var/lib/atopweb/gpu-procs.json` so early-detection survives restarts. Disable to run entirely from memory |
| `services.atopweb.fanotify` | `bool` | `false` | Enable the fanotify-based GPU device watcher for zero-lag process-start detection |
| `services.atopweb.extraArgs` | `[str]` | `[]` | Extra flags passed to atopweb (e.g. `[ "-i" "0" ]`) |
| `services.atopweb.package` | `package` | flake default | Override the atopweb package |

### What the module configures for you

Enabling the module:

- Loads the `msr` kernel module (`boot.kernelModules = [ "msr" ]`) so the
  service can open `/dev/cpu/*/msr` to read AMD memory-topology MSRs
  (`TOP_MEM`, `TOP_MEM2`, `SMM_ADDR`, `SMM_MASK`) for byte-exact memory
  reconciliation.
- Runs the systemd unit as **root** (`User = "root"`), which gives it
  unrestricted access to `/proc/*/fdinfo` (per-process DRM memory),
  `/dev/cpu/*/msr` (AMD memory topology), and
  `/sys/kernel/debug/dma_buf/bufinfo` (dma-buf totals) without any
  capability juggling.  `amdgpu_top` is therefore also invoked directly as
  root — no sudo wrapper required.

### Running amdgpu_top as root

Because the NixOS module runs the service as root, `amdgpu_top` inherits
root privileges and can read GPU performance counters and full fdinfo data
without any additional configuration.  The `sudo = true` option is no longer
needed when using the module:

```nix
services.atopweb = {
  enable       = true;
  ryzenAdjBin  = "${pkgs.ryzenadj}/bin/ryzenadj";
};
```

The `--sudo` flag and `sudo` module option remain available for non-NixOS
deployments where atopweb runs as a non-root user with a NOPASSWD sudoers
entry for `amdgpu_top`.

---

## Firewall

```nix
networking.firewall.allowedTCPPorts = [ 5899 ];
```

---

## Service logs

```bash
journalctl -u atopweb -f
journalctl -u atopweb -b   # since last boot
```

---

## Releasing

Bump `VERSION` in a PR to `main`.  Merging triggers the release workflow which
cross-compiles `atopweb-linux-amd64` and `atopweb-linux-arm64` and publishes
them as a GitHub Release tagged with the version.
