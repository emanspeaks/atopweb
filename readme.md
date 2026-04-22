# atopweb

Live AMD GPU / NPU web dashboard powered by [amdgpu_top](https://github.com/Umio-Yasuno/amdgpu_top).

`atopweb` is a small Go binary that runs `amdgpu_top` in JSON streaming mode,
forwards each update over a WebSocket, and serves a browser dashboard at a
configurable HTTP port.

---

## Dashboard

The browser UI updates in real time and shows:

**Stat cards** — GFX activity, media activity, SCLK, MCLK, FCLK, package
power, edge temperature, CPU Tctl, VDDGFX, VDDNB, VRAM usage, GTT usage.

**Charts** (time-based scrolling windows; widths configurable in the header):

| Chart | Signals |
| --- | --- |
| Temperature | Edge, CPU Tctl, SoC, GFX, Hotspot, Mem — with ryzenadj THM limit lines |
| GPU Activity | GFX %, Memory %, Media % |
| VRAM + GTT | Combined, VRAM-only, GTT-only (GiB) |
| CPU Core Power | Per-core power (W) for all 16 cores |
| Clocks | SCLK, MCLK, FCLK, FCLK avg, SoC Clk, VCN Clk |
| Package Power | Total, CPU cores, NPU — with ryzenadj STAPM / fast-PPT / slow-PPT / APU Slow limit lines |
| Voltage | VDDGFX, VDDNB (mV) |
| DRAM Bandwidth | Reads, Writes (MB/s) |
| NPU Tile Activity | Per-tile activity % for all 8 tiles |
| NPU Clocks | NPU Clk, MP-NPU Clk (MHz) |
| NPU Bandwidth | Reads, Writes (MB/s) |

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

**Header** — connection status, device info (ASIC name, driver, CU count,
VRAM type / size / bandwidth, peak FP32 TFLOPS, NPU name), ryzenadj limits
summary, and controls for update interval, plot width, and core-clock plot
width.

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
on the power and temperature charts and summarized in the header.

CPU core performance rankings are read from
`/sys/devices/system/cpu/cpu*/acpi_cppc/highest_perf` at first request and
served from `/api/cpu-ranks`.

---

## API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/` | GET | Serves the dashboard HTML |
| `/dashboard.css` | GET | Stylesheet |
| `/dashboard.js` | GET | Dashboard application |
| `/ws` | WS | WebSocket stream — pushes the latest `amdgpu_top` JSON frame to every connected client at the configured interval |
| `/api/config` | GET | Returns `{"interval_ms", "atopweb_version", "amdgpu_top_version"}` |
| `/api/interval?ms=N` | POST | Changes the amdgpu_top polling interval to N ms (50–60000); restarts the streamer |
| `/api/vram` | GET | Returns per-device `[{"name", "used_mib", "total_mib", "used_pct"}]` from the last frame |
| `/api/gpu-pct` | GET | Returns per-device `[{"name", "gpu_pct"}]` (GFX activity %) from the last frame |
| `/api/limits` | GET | Returns ryzenadj limits from the cached `ryzenadj -i` result (`stapm_w`, `fast_w`, `slow_w`, and thermal limits when available); fields omitted when ryzenadj is not configured or the value is absent |
| `/api/cpu-ranks` | GET | Returns `{"ranks": [...]}` — array indexed by CPU core number, value is performance rank (1 = best) derived from ACPI CPPC `highest_perf`; empty array when CPPC data is unavailable |

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
