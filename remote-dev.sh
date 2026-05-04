#!/bin/sh
./rsync.sh
ssh emanspeaks@192.168.2.44 -t "cd ~/atopweb-dev && nix develop"
