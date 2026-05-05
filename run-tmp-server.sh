#!/bin/sh
./build-tmp-server.sh
sudo /tmp/atopweb \
  --port 8099 \
  -s 100 \
  --sudo \
  --sudo-bin /run/wrappers/bin/sudo \
  --ryzenadj "$(command -v ryzenadj)" \
  --proc-cache /tmp/atopweb-gpu-procs.json \
  $*
  # --legacy-front \
