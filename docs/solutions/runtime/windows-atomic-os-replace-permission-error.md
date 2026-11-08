---
title: Windows Atomic os.replace PermissionError Under Active File Watchers
category: runtime
trigger: "PermissionError: [WinError 5] Access is denied ... os.replace(bin_tmp, bin_target)"
---

## Problem
Rapid atomic file replacement via `os.replace(src, dst)` on Windows raises `PermissionError` (`[WinError 5]` or `[WinError 32]`) when Vite dev server watchers or OS indexers hold transient read handles on the target file.

## Solution
Wrap `os.replace` and `Path.unlink` in a bounded linear backoff helper (`replace_with_retry` and `unlink_with_retry` in `compiler/compile_ptbxl.py`) that retries `PermissionError` before re-raising on final attempt exhaustion.
