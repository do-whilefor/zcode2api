//go:build !windows

package server

import (
	"os"
	"strings"
)

func osVersion() string {
	if b, e := os.ReadFile("/proc/sys/kernel/osrelease"); e == nil {
		return strings.TrimSpace(string(b))
	}
	return "unknown"
}
