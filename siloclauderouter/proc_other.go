//go:build !windows

package main

import "os/exec"

func setNoWindow(_ *exec.Cmd) {}
