//go:build !windows

package server

import "os"

func osVersion() string {
	if b, e := os.ReadFile("/proc/sys/kernel/osrelease"); e == nil {
		return stringsTrim(string(b))
	}
	return "unknown"
}
