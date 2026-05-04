//go:build linux

package main

import (
	"log"
	"os"
	"path/filepath"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// defaultFanotifyDevices returns GPU device nodes to watch.
// /dev/kfd covers ROCm/HIP; /dev/dri/render* covers Vulkan, OpenGL, and any
// other DRM client regardless of which compute stack they use.
func defaultFanotifyDevices() []string {
	devs := []string{}
	if _, err := os.Stat("/dev/kfd"); err == nil {
		devs = append(devs, "/dev/kfd")
	}
	// Glob all DRM render nodes (/dev/dri/renderD128, renderD129, …)
	paths, _ := filepath.Glob("/dev/dri/render*")
	devs = append(devs, paths...)
	return devs
}

// watchFanotifyGPU uses Linux fanotify to receive an immediate kernel
// notification whenever any process opens a GPU device node.  This fires
// before the process has allocated any GPU memory — earlier than both the
// KFD sysfs watcher and the amdgpu_top fdinfo poll.
//
// Requires CAP_SYS_ADMIN (or root).  Falls back gracefully when the
// capability is absent.
func watchFanotifyGPU(h *hub, tracker *procEventTracker, devices []string) {
	if len(devices) == 0 {
		devices = defaultFanotifyDevices()
	}
	if len(devices) == 0 {
		log.Printf("fanotify watcher: no GPU device nodes found; skipping")
		return
	}

	fd, err := unix.FanotifyInit(
		unix.FAN_CLASS_NOTIF|unix.FAN_CLOEXEC|unix.FAN_NONBLOCK,
		unix.O_RDONLY|unix.O_LARGEFILE,
	)
	if err != nil {
		log.Printf("fanotify watcher: fanotify_init: %v (need CAP_SYS_ADMIN; falling back to polling)", err)
		return
	}
	defer unix.Close(fd)

	marked := 0
	for _, dev := range devices {
		if err := unix.FanotifyMark(fd, unix.FAN_MARK_ADD, unix.FAN_OPEN,
			unix.AT_FDCWD, dev); err != nil {
			log.Printf("fanotify watcher: cannot watch %s: %v", dev, err)
			continue
		}
		log.Printf("fanotify watcher: watching %s", dev)
		marked++
	}
	if marked == 0 {
		return
	}

	myPID := os.Getpid()
	buf := make([]byte, 4096)

	for {
		n, err := unix.Read(fd, buf)
		if err != nil {
			if err == unix.EAGAIN || err == unix.EINTR {
				time.Sleep(5 * time.Millisecond)
				continue
			}
			log.Printf("fanotify watcher: read error: %v", err)
			return
		}

		const metaSize = int(unsafe.Sizeof(unix.FanotifyEventMetadata{}))
		for off := 0; off+metaSize <= n; {
			meta := (*unix.FanotifyEventMetadata)(unsafe.Pointer(&buf[off]))
			// Always close the per-event fd; we don't need to inspect the file.
			if evFd := int(meta.Fd); evFd >= 0 {
				unix.Close(evFd)
			}
			step := int(meta.Event_len)
			if step < metaSize {
				break // malformed event; stop processing this read
			}
			off += step

			pid := int(meta.Pid)
			if pid == myPID || pid <= 0 {
				continue
			}
			if !tracker.tryStart(pid) {
				continue // another layer already fired for this PID
			}
			name := readProcName(pid)
			if name == "" {
				continue // process already exited
			}
			h.broadcastProcEvent(procEvent{
				Type: "proc_event", Event: "start",
				PID: pid, Name: name, TimeMs: time.Now().UnixMilli(),
			})
			log.Printf("fanotify watcher: start pid=%d name=%q", pid, name)
		}
	}
}
