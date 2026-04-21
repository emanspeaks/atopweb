# atopweb

Live AMD GPU web dashboard powered by [amdgpu_top](https://github.com/Umio-Yasuno/amdgpu_top).

`atopweb` is a small Go binary that runs `amdgpu_top` in JSON streaming mode,
forwards each update over a WebSocket, and serves a browser dashboard at a
configurable HTTP port.  The dashboard shows live metrics for all detected AMD
GPUs: activity (GFX / Memory / Media), VRAM, clocks, power, temperatures, fan
speed, and per-process fdinfo usage.

---

## How it works

```text
amdgpu_top -J  →  atopweb  →  WebSocket (/ws)  →  browser dashboard (/)
```

`atopweb` does not contain any GPU driver code.  It shells out to the stock
`amdgpu_top` binary and relays its newline-delimited JSON stream to every
connected browser.  If `amdgpu_top` exits it restarts automatically after 5 s.

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

# faster updates
atopweb -s 500
```

Then open `http://localhost:5899` in a browser.

---

## All flags

| Flag | Default | Description |
| --- | --- | --- |
| `--port` | `5899` | TCP port to listen on |
| `--amdgpu-top` | *(search PATH)* | Path to the `amdgpu_top` binary |
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
            enable   = true;
            port     = 5899;   # optional
            # nopc   = true;   # skip perf counters
            # interval = 500;  # 500 ms updates
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
| `services.atopweb.nopc` | `bool` | `false` | Skip perf counter reads |
| `services.atopweb.interval` | `int` | `1000` | Refresh period in ms |
| `services.atopweb.extraArgs` | `[str]` | `[]` | Extra flags passed to atopweb (e.g. `[ "-i" "0" ]`) |
| `services.atopweb.package` | `package` | flake default | Override the atopweb package |

The NixOS module pins `amdgpu_top` to `pkgs.amdgpu-top` from the same nixpkgs
revision, passing its store path via `--amdgpu-top` so the service never relies
on `$PATH`.

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
