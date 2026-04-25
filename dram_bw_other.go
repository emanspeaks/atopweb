//go:build !linux

package main

func initDRAMBW()                                          {}
func readDRAMBW() (readBps, writeBps uint64, ok bool)      { return 0, 0, false }
