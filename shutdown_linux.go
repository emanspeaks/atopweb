//go:build linux

package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"
	"time"
	"unsafe"

	"github.com/godbus/dbus/v5"
	"golang.org/x/sys/unix"
)

// watchShutdownFile watches /run/systemd/shutdown/ via inotify and pushes a
// "system_alert" WebSocket frame the instant the "scheduled" file appears.
// This fires within milliseconds of sudo reboot / shutdown being invoked,
// giving connected browsers time to display the message before systemd stops
// this service.
//
// If /run/systemd/shutdown does not exist yet (it is only created by
// systemd-shutdownd on the first scheduled shutdown), we watch /run/systemd
// instead and upgrade to the subdirectory when it appears.
func watchShutdownFile(h *hub) {
	const schedDir  = "/run/systemd/shutdown"
	const schedFile = "scheduled"

	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC)
	if err != nil {
		log.Printf("shutdown watcher: inotify_init1: %v", err)
		return
	}
	defer unix.Close(fd)

	var wd int
	var watchDir string

	addWatch := func(path string) bool {
		w, err := unix.InotifyAddWatch(fd, path, unix.IN_CREATE|unix.IN_MOVED_TO|unix.IN_CLOSE_WRITE)
		if err != nil {
			log.Printf("shutdown watcher: inotify_add_watch(%s): %v", path, err)
			return false
		}
		if watchDir != "" {
			unix.InotifyRmWatch(fd, uint32(wd))
		}
		wd = w
		watchDir = path
		return true
	}

	if _, err := os.Stat(schedDir); err == nil {
		if !addWatch(schedDir) {
			return
		}
	} else {
		if !addWatch("/run/systemd") {
			return
		}
	}

	// Push immediately if already pending at startup (e.g., server restart
	// during a scheduled delayed shutdown).
	if msg := checkShutdownPending(); msg != "" {
		pushShutdownAlert(h, msg)
	}

	buf := make([]byte, 4096)
	for {
		n, err := unix.Read(fd, buf)
		if n < unix.SizeofInotifyEvent {
			if err != nil {
				log.Printf("shutdown watcher: read: %v", err)
			}
			continue
		}
		var offset uint32
		for int(offset)+unix.SizeofInotifyEvent <= n {
			ev := (*unix.InotifyEvent)(unsafe.Pointer(&buf[offset]))
			offset += uint32(unix.SizeofInotifyEvent)
			name := ""
			if ev.Len > 0 && int(offset+ev.Len) <= n {
				raw := buf[offset : offset+ev.Len]
				name = strings.TrimRight(string(raw), "\x00")
				offset += ev.Len
			}
			switch {
			case watchDir != schedDir && name == "shutdown":
				addWatch(schedDir)
			case name == schedFile:
				time.Sleep(10 * time.Millisecond) // let the kernel finish writing
				if msg := checkShutdownPending(); msg != "" {
					pushShutdownAlert(h, msg)
				}
			}
		}
	}
}

func pushShutdownAlert(h *hub, msg string) {
	type alert struct {
		Type            string `json:"type"`
		ShutdownPending string `json:"shutdown_pending"`
	}
	b, _ := json.Marshal(alert{Type: "system_alert", ShutdownPending: msg})
	h.pushAll(b)
	log.Printf("shutdown alert pushed: %s", msg)
}

// watchLogindShutdown subscribes to systemd-logind's PrepareForShutdown signal
// on the system D-Bus. logind emits PrepareForShutdown(true) immediately before
// any shutdown/reboot/halt/kexec begins — including immediate `sudo reboot`,
// ACPI power-button presses, and GUI-initiated shutdowns — none of which write
// /run/systemd/shutdown/scheduled. This is the canonical signal documented at
// https://www.freedesktop.org/software/systemd/man/org.freedesktop.login1.html.
//
// For delayed shutdowns the inotify watcher fires first (with a countdown
// message); this watcher then refines the message when shutdown actually
// starts. For immediate shutdowns this is the only thing that fires.
func watchLogindShutdown(h *hub) {
	conn, err := dbus.SystemBus()
	if err != nil {
		log.Printf("logind watcher: connect system bus: %v", err)
		return
	}

	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.login1.Manager"),
		dbus.WithMatchMember("PrepareForShutdown"),
		dbus.WithMatchObjectPath("/org/freedesktop/login1"),
	); err != nil {
		log.Printf("logind watcher: add match: %v", err)
		return
	}

	ch := make(chan *dbus.Signal, 8)
	conn.Signal(ch)
	for sig := range ch {
		if sig.Name != "org.freedesktop.login1.Manager.PrepareForShutdown" {
			continue
		}
		if len(sig.Body) < 1 {
			continue
		}
		active, _ := sig.Body[0].(bool)
		if !active {
			continue
		}
		msg := checkShutdownPending()
		if msg == "" {
			msg = "shutdown or reboot in progress"
		}
		pushShutdownAlert(h, msg)
	}
}
