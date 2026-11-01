//go:build !windows

package server

import "os/exec"

func hideChildWindow(command *exec.Cmd) {}
