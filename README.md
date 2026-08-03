# ComfyUI-ProgressThrottleSafe

**Temporary workaround** for ComfyUI generation slowing down 30–60% while the
browser tab is active/visible ([issue link here]). This should become
unnecessary once the frontend addresses the underlying causes — check the
linked issue before installing.

日本語: [README.ja.md](README.ja.md)

## The problem

With the ComfyUI tab active on the same GPU that runs inference, a 31-step
job measured **25.3 s vs 15.6 s** when the tab was inactive (+62%). The
overhead decomposes into three layers (full measurements in the issue):

| Layer | Cost | Fix |
|---|---|---|
| Compositor churn from always-running CSS animations (tab spinner etc.) during execution | ≈4.6 s | This patch: **Quiet Mode** pauses CSS animations while a job runs |
| Live preview stream (per-step generation/decode) | ≈2.2 s | Built-in setting: `Comfy.Execution.PreviewMethod` = `none` (no patch needed) |
| Per-step `progress` / `progress_state` events driving Vue DOM updates | ≈3 s | This patch: **Throttle** coalesces both streams into ≤2 batches/s |

LiteGraph canvas rendering, the minimap, Vue Nodes, and OS focus priority
were tested and ruled out.

Result on the reference machine: **25.3 s → ~18 s** with the tab active,
browser rendered by the inference GPU (RTX 5090), main monitor.

## Install

1. Remove any older throttle patches (stacked `dispatchCustomEvent` wrappers
   are unsupported and produce a startup warning).
2. Copy this folder into `ComfyUI/custom_nodes/`.
3. Restart ComfyUI, hard-refresh the browser (Ctrl+F5).
4. Console should show `[progress-throttle-safe] active` and
   `[quiet-mode] registered`; during a job, `[quiet-mode] on (css animations paused)`.
5. Recommended: set Settings → Execution → Preview Method to `none`.

## Runtime configuration (browser console)

```js
window.comfyProgressThrottleSafe.setProgressInterval(1000) // default 500 ms
window.comfyProgressThrottleSafe.getStats()                // received vs delivered
window.comfyProgressThrottleSafe.disable() / .enable() / .uninstall()

window.comfyExecutionQuietMode.disable() / .enable()
window.comfyExecutionQuietMode.setPauseCanvas(true)        // experimental
```

## Safety design

- The latest pending progress snapshot is force-flushed *before*
  `execution_success` / `execution_error` / `execution_interrupted` /
  `executing: null`, so stale progress never resurfaces after completion.
- Pending payloads are keyed by `prompt_id`; concurrent jobs don't clobber
  each other. Pending data is dropped on reconnect.
- Hidden tabs pass through unthrottled (the browser already suppresses their
  rendering).
- Quiet Mode only pauses CSS *animations*; transitions are untouched so
  `transitionend`-dependent code keeps working. Everything restores the
  moment the job ends.
- `requestAnimationFrame`, LiteGraph drawing, and execution-control events
  are never touched.

## Compatibility

Tested with comfyui-frontend-package **1.47.11** on Firefox,
Windows 11 + WSL2 (CUDA), RTX 5090. The patch wraps
`api.dispatchCustomEvent`, which is internal frontend API — future frontend
releases may break it. If the console warning changes or the patch stops
logging, remove the folder and check the issue thread.

## Known limitations

- On-screen progress updates at most twice per second (configurable).
- Decorative spinners freeze during generation (by design).
- Trades UI feedback smoothness for inference throughput; if you prefer
  smooth progress, raise the interval or disable modules individually.

## License

MIT
