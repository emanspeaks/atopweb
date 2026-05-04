package main

import (
	"fmt"
	"log"
	"sync"
)

// diagnostics collects non-fatal error messages from the privileged readers
// (MSR, DRM fdinfo, debugfs) and deduplicates them by message text.  Each
// unique message is emitted once to the process's stderr via log.Printf (so
// systemd captures it to the journal / syslog) and surfaced in every
// systemInfo response via the Errors field so the dashboard's log pane can
// show it to the user.  The sticky list is never cleared — a given failure
// mode is a configuration problem, not a transient event.
type diagnostics struct {
	mu    sync.Mutex
	seen  map[string]struct{}
	items []string
}

var diag diagnostics

func (d *diagnostics) report(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.seen[msg]; ok {
		return
	}
	if d.seen == nil {
		d.seen = make(map[string]struct{})
	}
	d.seen[msg] = struct{}{}
	d.items = append(d.items, msg)
	log.Printf("atopweb diagnostic: %s", msg)
}

func (d *diagnostics) snapshot() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.items) == 0 {
		return nil
	}
	out := make([]string, len(d.items))
	copy(out, d.items)
	return out
}
