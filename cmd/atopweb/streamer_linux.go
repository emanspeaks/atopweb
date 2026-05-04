package main

import (
	"bufio"
	"bytes"
	"context"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// runStreamer loops, launching amdgpu_top -J and broadcasting each JSON line
// to all connected WebSocket clients.  On normal exit it retries in 5 s; on
// kill (context cancelled) it retries after 200 ms.
func runStreamer(binary string, baseArgs []string, h *hub) {
	for {
		h.mu.Lock()
		ms := h.intervalMs
		h.mu.Unlock()

		args := append(append([]string{}, baseArgs...), "-s", strconv.Itoa(ms))
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.Command(binary, args...)
		// Put the process in its own group so we can kill sudo + amdgpu_top
		// together. exec.CommandContext only kills the named binary (sudo), but
		// amdgpu_top inherits sudo's stdout pipe FD and keeps the scanner alive.
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

		var stderr bytes.Buffer
		cmd.Stderr = &stderr

		h.mu.Lock()
		h.cancelFn = cancel
		h.mu.Unlock()

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			cancel()
			h.mu.Lock()
			h.cancelFn = nil
			h.mu.Unlock()
			log.Printf("amdgpu_top pipe error: %v; retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}
		if err := cmd.Start(); err != nil {
			cancel()
			h.mu.Lock()
			h.cancelFn = nil
			h.mu.Unlock()
			log.Printf("amdgpu_top failed to start: %v; retrying in 5s", err)
			time.Sleep(5 * time.Second)
			continue
		}

		go func() {
			<-ctx.Done()
			if cmd.Process != nil {
				syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			}
			// Close the read end of the pipe so the scanner unblocks
			// immediately even if amdgpu_top (sudo's child) outlives sudo.
			stdout.Close()
		}()

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4<<20), 4<<20) // 4 MiB; JSON frames can be large
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			frame := make([]byte, len(line))
			copy(frame, line)
			h.broadcast(frame)
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			log.Printf("amdgpu_top read error: %v", err)
		}

		wasKilled := ctx.Err() != nil
		cancel()
		cmd.Wait()

		h.mu.Lock()
		h.cancelFn = nil
		h.mu.Unlock()

		if msg := strings.TrimSpace(stderr.String()); msg != "" && !wasKilled {
			log.Printf("amdgpu_top stderr: %s", msg)
		}
		if wasKilled {
			h.mu.Lock()
			newMs := h.intervalMs
			h.mu.Unlock()
			log.Printf("amdgpu_top restarting at %d ms", newMs)
			time.Sleep(200 * time.Millisecond)
		} else {
			log.Printf("amdgpu_top exited unexpectedly; retrying in 5s")
			time.Sleep(5 * time.Second)
		}
	}
}

func buildAtopArgs(updateIdx, instance int, pci string, apu, single, nopc bool) []string {
	// -s (interval) is omitted here; runStreamer injects it dynamically so that
	// changing the interval via /api/interval takes effect without restarting atopweb.
	args := []string{
		"-J",
		"-u", strconv.Itoa(updateIdx),
	}
	if instance >= 0 {
		args = append(args, "-i", strconv.Itoa(instance))
	}
	if pci != "" {
		args = append(args, "--pci", pci)
	}
	if apu {
		args = append(args, "--apu")
	}
	if single {
		args = append(args, "--single")
	}
	if nopc {
		args = append(args, "--no-pc")
	}
	return args
}

// getAtopVersion probes the amdgpu_top binary for its version string.
func getAtopVersion(binary string) string {
	for _, arg := range []string{"--version", "-V"} {
		if out, err := exec.Command(binary, arg).Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return "unknown"
}
