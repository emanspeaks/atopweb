@echo off
C:\exe\zig-0.17.0\zig.exe cc -target x86_64-linux-gnu -fno-sanitize=undefined -IC:\scratch\mesa\drm -IC:\scratch\mesa\drm\include\drm -IC:\scratch\mesa\drm\amdgpu %*
