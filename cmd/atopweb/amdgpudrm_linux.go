//go:build linux && cgo

package main

import (
	"fmt"
	"log"
	"os"
	"time"

	amdgpu "github.com/emanspeaks/amdgpu-go/amdgpu"
)

const drmAvailable = true

// enumerateGPUDevices opens all available AMD GPU render nodes.
func enumerateGPUDevices() (indices []int, devices []*amdgpu.Device) {
	for card := 0; card < 16; card++ {
		path := fmt.Sprintf("/dev/dri/renderD%d", 128+card)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			break
		}
		dev, err := amdgpu.Open(card)
		if err != nil {
			log.Printf("amdgpudrm: skipping renderD%d: %v", 128+card, err)
			continue
		}
		indices = append(indices, card)
		devices = append(devices, dev)
	}
	return
}

func runDRMPoller(h *hub, noPC bool) {
	const grbmSamples = 32

	for {
		indices, devices := enumerateGPUDevices()
		if len(devices) == 0 {
			log.Printf("amdgpudrm: no devices opened; retrying in 5s")
			time.Sleep(5 * time.Second)
			continue
		}
		log.Printf("amdgpudrm: polling %d GPU(s)", len(devices))

		failed := drmPollLoop(h, indices, devices, noPC, grbmSamples)
		for _, dev := range devices {
			dev.Close()
		}
		if failed {
			log.Printf("amdgpudrm: device error; re-enumerating in 5s")
			time.Sleep(5 * time.Second)
		}
	}
}

func drmPollLoop(h *hub, indices []int, devices []*amdgpu.Device, noPC bool, grbmSamples int) bool {
	states := make([]*amdgpu.PollState, len(devices))
	for i, dev := range devices {
		states[i] = amdgpu.InitPollState(dev, indices[i])
	}

	for {
		h.mu.Lock()
		intervalMs := h.intervalMs
		atopVer := h.atopVersion
		h.mu.Unlock()

		intervalDur := time.Duration(intervalMs) * time.Millisecond
		start := time.Now()

		// GRBM sampling occupies the first 80% of the interval so the
		// remaining 20% is available for memory and sysfs reads.
		var grbmData []amdgpu.GRBMSample
		if !noPC {
			sampleDur := intervalDur * 8 / 10
			var err error
			grbmData, err = amdgpu.SampleGRBMMulti(devices, states, sampleDur, grbmSamples)
			if err != nil {
				log.Printf("amdgpudrm: GRBM sampling error: %v", err)
				return true
			}
		}

		snaps := make([]*amdgpu.DeviceSnapshot, len(devices))
		for i, dev := range devices {
			var gs *amdgpu.GRBMSample
			if grbmData != nil {
				gs = &grbmData[i]
			}
			snap, err := amdgpu.ReadDeviceSnapshot(dev, indices[i], states[i], gs, noPC)
			if err != nil {
				log.Printf("amdgpudrm: snapshot error renderD%d: %v", 128+indices[i], err)
				return true
			}
			snaps[i] = snap
		}

		frameJSON, err := amdgpu.MarshalFrameJSON(snaps, intervalMs, atopVer)
		if err != nil {
			log.Printf("amdgpudrm: frame marshal error: %v", err)
		} else {
			h.broadcast(frameJSON)
		}

		if rem := intervalDur - time.Since(start); rem > 0 {
			time.Sleep(rem)
		}
	}
}
