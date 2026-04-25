# atopweb Agent Guide

## Quick Start

```bash
# Build
go build -o atopweb .

# Run (requires Linux + AMD GPU + amdgpu_top)
./atopweb --port 5899
```

Open `http://localhost:5899` in a browser.

## Critical Constraints

- **VERSION bump required**: Every PR to `main` must update the `VERSION` file. CI enforces this. Exempt files: `readme.md`, `assets/*`, `.github/workflows/exempt.txt`.

- **Build order**: `go vet ./...` → `go build` → verify binary runs. No separate test suite.

- **NixOS deployment**: 
  1. Run `go mod tidy && nix run github:nix-community/gomod2nix -- generate` after `go.mod` changes
  2. Commit `gomod2nix.toml` before `nix build`
  3. The `gomod2nix.yml` workflow auto-updates it on `go.mod` changes

- **Go version**: `go 1.25.0` (specify explicitly in `go.mod`)

## Architecture Highlights

- **Entry point**: `main.go` — single binary, no subpackages
- **Core flow**: `amdgpu_top -J` → WebSocket broadcast → browser dashboard
- **Process detection**: Three-layer pipeline (KFD poll → known-proc cache → fdinfo fallback)
- **Memory accounting**: Split into two WebSocket frames:
  - `amdgpu_top` JSON (GPU activity, sensors, fdinfo) at configured interval
  - `{"type":"mem",…}` frame at same cadence (fast-changing memory)
  - `{"type":"system",…}` frame at 1 Hz (slow/static: hwmon, CPU%, uptime)
- **MSR dependency**: Reads AMD `TOP_MEM`, `TOP_MEM2`, `SMM_ADDR`, `SMM_MASK` via `/dev/cpu/*/msr` for byte-exact memory reconciliation. If unreadable, firmware-reservation segments stay blank with diagnostic in dashboard log.

## Key Files

| File | Purpose |
|------|---------|
| `main.go` | All logic: WebSocket hub, HTTP handlers, process watchers, memory readers |
| `dashboard.html/css/js` | Browser UI (embedded via `//go:embed`) |
| `flake.nix` | NixOS module + Go build definition |
| `gomod2nix.toml` | Nix dependency hashes (auto-generated) |
| `VERSION` | Semantic version (read at build time into binary) |

## NixOS Module Options

```nix
services.atopweb = {
  enable       = true;
  port         = 5899;              # optional
  sudo         = true;              # run amdgpu_top via sudo
  ryzenAdjBin  = "${pkgs.ryzenadj}/bin/ryzenadj";  # APU power/thermal limits
  fanotify     = true;              # zero-lag process start detection
  gpuProcCache = true;              # persist learned process names (default)
  nopc         = true;              # skip perf counters
  interval     = 100;               # 100 ms updates
  extraArgs    = [ "-i" "0" ];      # select GPU
};
```

## Common Mistakes to Avoid

- **Don't modify `go.sum` manually** — always run `go mod tidy` first
- **Don't forget `gomod2nix.toml`** — CI fails if `go.mod` changes without updating it
- **Don't assume `dmidecode` in PATH** — binary search includes `/run/current-system/sw/bin/dmidecode` for NixOS
- **Don't expect Windows support** — reads `/proc`, `/sys`, MSRs; Linux-only
- **Don't run as non-root without sudo** — full fdinfo/MSR access requires root or NOPASSWD sudoers rule

## Testing

No automated tests. Manual verification:

1. `./atopweb --help` shows usage
2. Dashboard loads at `http://localhost:5899`
3. WebSocket frames arrive (check browser DevTools → Network → WS)
4. Memory bar shows segments (requires `msr`, `amd_uncore`, `amd_atl` kernel modules)

## Release Flow

1. Bump `VERSION` in a PR to `main`
2. Merge → `release.yml` workflow:
   - Builds `atopweb-linux-amd64` and `atopweb-linux-arm64`
   - Creates GitHub Release with binaries
   - Tag format: `vX.Y.Z`
