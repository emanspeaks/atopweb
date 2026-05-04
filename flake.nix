{
  description = "atopweb — AMD GPU monitor web dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    gomod2nix = {
      url = "github:nix-community/gomod2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, gomod2nix }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
    in
    flake-utils.lib.eachSystem supportedSystems (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) lib;
        inherit (gomod2nix.legacyPackages.${system}) buildGoApplication;

        atopweb = buildGoApplication {
          pname = "atopweb";
          version = lib.fileContents ./VERSION;
          src = ./.;
          modules = ./gomod2nix.toml;

          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = [ pkgs.libdrm ];

          meta = {
            description = "Web dashboard server that streams amdgpu_top JSON output over WebSocket";
            license = lib.licenses.mit;
            platforms = lib.platforms.linux;
            mainProgram = "atopweb";
          };
        };
      in
      {
        packages = {
          default = atopweb;
          inherit atopweb;
        };
      }
    )
    //
    {
      nixosModules.default = { config, pkgs, lib, ... }:
        let
          cfg = config.services.atopweb;
        in
        {
          options.services.atopweb = {
            enable = lib.mkEnableOption "atopweb GPU web dashboard service";

            port = lib.mkOption {
              type = lib.types.port;
              default = 5899;
              description = "TCP port the web dashboard listens on.";
            };

            nopc = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Skip GPU performance counter reads (passes --no-pc to amdgpu_top).
                Saves power and avoids needing CAP_PERFMON, but GRBM/GRBM2 data
                will be absent.
              '';
            };

            interval = lib.mkOption {
              type = lib.types.ints.positive;
              default = 1000;
              description = "amdgpu_top refresh period in milliseconds.";
            };

            showGttMargin = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Show Non-GTT and GTT Margin calculations in the dashboard
                memory bar legend (passes --show-gtt-margin to atopweb).
              '';
            };

            amdgpuTopBin = lib.mkOption {
              type = lib.types.str;
              default = "${pkgs.amdgpu_top}/bin/amdgpu_top";
              defaultText = lib.literalExpression ''"''${pkgs.amdgpu_top}/bin/amdgpu_top"'';
              description = ''
                Path to the amdgpu_top binary passed to atopweb via --amdgpu-top.
                Override with a security.wrappers path when amdgpu_top needs to run
                as root (e.g. amdgpuTopBin = "/run/wrappers/bin/amdgpu_top").
                When using a setuid wrapper, also set grantPerfmonCapability = false.
              '';
            };

            sudo = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Launch amdgpu_top as root via sudo rather than running the
                whole service as root.  When enabled, atopweb is passed
                --sudo and a NOPASSWD sudoers rule is automatically added
                allowing the atopweb user to run the configured amdgpu_top
                binary as root without a password prompt.
              '';
            };

            ryzenAdjBin = lib.mkOption {
              type = lib.types.str;
              default = "";
              description = ''
                Path to the ryzenadj binary.  When set, atopweb calls
                ryzenadj -i (via sudo when sudo = true) to read APU power
                limits (STAPM, fast-PPT, slow-PPT) for the power chart.
                Example: "''${pkgs.ryzenadj}/bin/ryzenadj"
              '';
            };

            gpuProcCache = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = ''
                Persist the GPU process name learning cache across restarts.
                When enabled, atopweb stores known GPU process names in
                /var/lib/atopweb/gpu-procs.json so the early-detection watcher
                can fire before a familiar process touches the GPU.
              '';
            };

            fanotify = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Enable Linux fanotify-based GPU device node watcher for
                zero-lag process start detection.  Requires CAP_SYS_ADMIN;
                when enabled the systemd service is granted that capability
                via AmbientCapabilities.
              '';
            };

            extraArgs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [];
              description = ''
                Additional arguments passed verbatim to atopweb
                (e.g. [ "-i" "0" "--pci" "0000:03:00.0" ]).
              '';
            };

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              defaultText = lib.literalExpression "atopweb flake package";
              description = "The atopweb package to use.";
            };
          };

          config = lib.mkIf cfg.enable {
            # The memory-reservation reconciliation in buildSystemInfo reads AMD
            # MSRs (TOP_MEM, TOP_MEM2, SMM_ADDR, SMM_MASK) via /dev/cpu/*/msr to
            # distinguish DRAM-backed firmware reservation from MMIO address
            # space above TOP_MEM2.  The msr character device only exists when
            # the msr kernel module is loaded.
            boot.kernelModules = [ "msr" "amd_uncore" "amd_atl" ];

            systemd.services.atopweb = {
              description = "atopweb GPU web dashboard";
              wantedBy = [ "multi-user.target" ];
              after = [ "network.target" ];

              serviceConfig = {
                ExecStart = lib.concatStringsSep " " (
                  [
                    "${cfg.package}/bin/atopweb"
                    "--port" (toString cfg.port)
                    "--amdgpu-top" cfg.amdgpuTopBin
                    "-s" (toString cfg.interval)
                  ]
                  ++ lib.optional cfg.nopc "--no-pc"
                  ++ lib.optional cfg.showGttMargin "--show-gtt-margin"
                  ++ lib.optionals cfg.sudo [ "--sudo" "--sudo-bin" "/run/wrappers/bin/sudo" ]
                  ++ lib.optionals (cfg.ryzenAdjBin != "") [ "--ryzenadj" cfg.ryzenAdjBin ]
                  ++ lib.optionals cfg.gpuProcCache [ "--proc-cache" "/var/lib/atopweb/gpu-procs.json" ]
                  ++ lib.optional  cfg.fanotify    "--fanotify"
                  ++ cfg.extraArgs
                );

                # Run as root so that /proc/*/fdinfo, /dev/cpu/*/msr, and
                # /sys/kernel/debug/dma_buf/bufinfo are all accessible without
                # wrestling with ambient capabilities or hidepid restrictions.
                # amdgpu_top can therefore also be invoked directly (no sudo).
                User = "root";

                StateDirectory = lib.mkIf cfg.gpuProcCache "atopweb";

                Restart = "on-failure";
                RestartSec = "5s";

                PrivateTmp = true;
              };
            };

          };
        };
    };
}
