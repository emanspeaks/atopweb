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
activity, VRAM usage, GTT usage, SCLK, MCLK, FCLK, average power, edge
temperature, CPU Tctl, VDDGFX, VDDNB. Per-GPU cards auto-hide when their
sensor stays idle so empty fields don't clutter the layout; they reappear
automatically when data returns.

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
mark the start/stop of any GPU or NPU process, labelled with the process
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
timestamp, and inputs for update interval, plot width, and core-clock plot
width.

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

Host stats outside the GPU stream (total RAM, uptime, load average, and
every `/sys/class/hwmon` sensor — fans, voltages, currents, powers, temps)
are collected on demand and served from `/api/system`. The dashboard polls
this endpoint at 1 Hz and uses it to populate the Fan Speed, PPT, and
Uptime cards, the VRAM chart's physical-memory ceiling, and a PPT trace on
the Package Power chart.

---

## API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | GET | Serves the dashboard HTML |
| `/dashboard.css` | GET | Stylesheet |
| `/dashboard.js` | GET | Dashboard application |
| `/ws` | WS | WebSocket stream — pushes the latest `amdgpu_top` JSON frame to every connected client at the configured interval |
| `/api/config` | GET | Returns `{"interval_ms", "atopweb_version", "amdgpu_top_version", "total_ram_mib", "kernel_version"}`; on NixOS also `"nixos_version"` and `"nixos_generation"` |
| `/api/interval?ms=N` | POST | Changes the amdgpu_top polling interval to N ms (50–60000); restarts the streamer |
| `/api/vram` | GET | Returns per-device `[{"name", "used_mib", "total_mib", "used_pct"}]` from the last frame |
| `/api/gpu-pct` | GET | Returns per-device `[{"name", "gpu_pct"}]` (GFX activity %) from the last frame |
| `/api/limits` | GET | Returns cached ryzenadj limits: `stapm_w`, `fast_w`, `slow_w`, `apu_slow_w`, `thm_core_c`, `thm_gfx_c`, `thm_soc_c`. Fields are omitted when ryzenadj is not configured or the value is absent |
| `/api/cpu-ranks` | GET | Returns `{"ranks": [...]}` — array indexed by CPU core number, value is performance rank (1 = best) derived from ACPI CPPC `highest_perf`; empty array when CPPC data is unavailable |
| `/api/system` | GET | Returns host stats: `total_ram_mib`, `avail_ram_mib`, `uptime_sec`, `loadavg`, and arrays `fans` / `voltages` / `currents` / `powers` / `temps` (each entry is `{"chip","label","value"}` — values in RPM / mV / mA / µW / °C respectively). Polled at 1 Hz by the dashboard |

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
| `--sudo` | `false` | Launch `amdgpu_top` (and `ryzenadj`) via `sudo -n` instead of running atopweb as root |
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
| `--fanotify` | `false` | Enable the fanotify-based GPU device watcher for zero-lag process-start detection. Requires `CAP_SYS_ADMIN`; falls back silently when the capability is absent |

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
            fanotify     = true;         # zero-lag process start detection (grants CAP_SYS_ADMIN)
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
| `services.atopweb.fanotify` | `bool` | `false` | Enable the fanotify-based GPU device watcher. When `true`, the systemd unit is granted `CAP_SYS_ADMIN` via `AmbientCapabilities` / `CapabilityBoundingSet` |
| `services.atopweb.extraArgs` | `[str]` | `[]` | Extra flags passed to atopweb (e.g. `[ "-i" "0" ]`) |
| `services.atopweb.package` | `package` | flake default | Override the atopweb package |

### Running amdgpu_top as root

`amdgpu_top` needs elevated privileges to read GPU performance counters and
full fdinfo data.  The recommended approach is `sudo = true` in the module,
which:

- passes `--sudo --sudo-bin /run/wrappers/bin/sudo` to atopweb
- automatically adds a NOPASSWD sudoers entry so the `atopweb` service user
  can run `amdgpu_top` (and `ryzenadj` if configured) without a password

```nix
services.atopweb = {
  enable      = true;
  sudo        = true;
  ryzenAdjBin = "${pkgs.ryzenadj}/bin/ryzenadj";
};
```

Alternatively, a `security.wrappers` setuid wrapper works too:

```nix
security.wrappers.amdgpu_top = {
  source      = "${pkgs.amdgpu_top}/bin/amdgpu_top";
  owner       = "root";
  group       = "atopweb";
  setuid      = true;
  permissions = "u+rx,g+rx,o-rwx";
};

services.atopweb = {
  enable       = true;
  amdgpuTopBin = "/run/wrappers/bin/amdgpu_top";
};
```

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
