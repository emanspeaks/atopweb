@echo off
rem Rebuild cross-compile stub archives for libdrm and libdrm_amdgpu.
rem Run once after cloning, or whenever drm_stub.c changes.
rem Requires zig 0.17+ at C:\exe\zig-0.17.0\zig.exe.
C:\exe\zig-0.17.0\zig.exe cc -target x86_64-linux-gnu -fno-sanitize=undefined -c drm_stub.c -o drm_stub.o || exit /b 1
C:\exe\zig-0.17.0\zig.exe ar rcs libdrm.a drm_stub.o || exit /b 1
C:\exe\zig-0.17.0\zig.exe ar rcs libdrm_amdgpu.a drm_stub.o || exit /b 1
echo libdrm.a and libdrm_amdgpu.a rebuilt.
