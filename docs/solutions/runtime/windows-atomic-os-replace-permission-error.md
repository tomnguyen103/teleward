---
title: Windows Atomic os.replace PermissionError Under Active File Watchers
category: runtime
trigger: "PermissionError: [WinError 5] Access is denied ... os.replace(bin_tmp, bin_target)"
---

## Problem
Rapid `os.replace(src, dst)` calls on Windows raise `PermissionError` (`[WinError 5]` or `[WinError 32]`). Vite watchers and OS indexers hold transient read handles on the target file.

## Solution
Wrap `os.replace`, `shutil.copy2`, and `Path.unlink` in bounded linear backoff helpers (`replace_with_retry`, `copy_with_retry`, `unlink_with_retry`) in `compiler/compile_ptbxl.py`. Restore or remove `ptbxl_120.bin` inside `atomic_write_artifacts` if index replacement fails.

