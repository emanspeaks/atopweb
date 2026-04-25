package main

import (
	"context"
	"encoding/json"
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func RunStreamer(binary string, baseArgs []string, h *Hub) {
	for {
		h.mu.Lock()
		ms := h.intervalMs
		h.mu.Unlock()

		args := append(append([]string{}, baseArgs...), "-s", strconv.Itoa(ms))
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.Command(binary, args...)
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
			stdout.Close()
		}()

		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 4<<20), 4<<20)
		for scanner.Scan() {
			line := scanner.Bytes()
			if len(line) == 0 {
				continue
			}
			frame := make([]byte, len(line))
			copy(frame, line)
			h.Broadcast(frame)
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

func BuildAtopArgs(updateIdx, instance int, pci string, apu, single, nopc bool) []string {
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

func GetAtopVersion(binary string) string {
	for _, arg := range []string{"--version", "-V"} {
		if out, err := exec.Command(binary, arg).Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return "unknown"
}
