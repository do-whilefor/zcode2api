package server

import (
	"os/exec"
	"syscall"
)

func hideChildWindow(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
