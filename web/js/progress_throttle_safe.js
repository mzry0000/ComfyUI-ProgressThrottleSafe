import { api } from "../../scripts/api.js";
import { app } from "../../scripts/app.js";

/*
 * ComfyUI Progress Event Throttle - safe revision
 *
 * The measured active-tab slowdown remained after LiteGraph rendering,
 * minimap and Vue Nodes were ruled out. This patch therefore touches only the
 * high-frequency frontend event delivery path.
 *
 * Important design points:
 * - progress_state and legacy progress share one scheduler, so their paired
 *   updates are dispatched in one JS task and Vue can batch DOM work;
 * - latest absolute progress payloads replace older pending payloads;
 * - final pending data is flushed BEFORE success/error/interruption handlers;
 * - jobs are keyed by prompt_id, preventing concurrent jobs from overwriting
 *   one another;
 * - hidden tabs pass through unchanged, because the browser already suppresses
 *   their style/layout/paint work;
 * - requestAnimationFrame, LiteGraph drawing and model execution are untouched.
 */

const CONFIG = {
    enabled: true,

    // Total cadence for the paired progress_state + progress stream.
    // 500 ms = at most 2 UI batches/second. Try 750 or 1000 for a stronger
    // reduction. Use the runtime setter shown in README; no restart is needed.
    progressIntervalMs: 500,

    // Small delay used when a new batch can run immediately. It allows the
    // progress_state/progress pair to arrive before one combined flush.
    coalesceWindowMs: 16,

    // These are off by default for compatibility. Set a positive interval only
    // when a workflow actually emits high-frequency text or live previews.
    progressTextIntervalMs: 0,
    previewIntervalMs: 0,

    // Only throttle while the document is visible. Background tabs are already
    // aggressively throttled by the browser and should retain exact state.
    visibleOnly: true,

    log: true,
};

const PATCH_SLOT = "__comfyProgressThrottleSafeV2";
const GLOBAL_NAME = "comfyProgressThrottleSafe";
const TERMINAL_EVENTS = new Set([
    "execution_success",
    "execution_error",
    "execution_interrupted",
]);

function clampInterval(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.max(16, Math.round(number));
}

app.registerExtension({
    name: "bismarck.ProgressThrottleSafeV2",

    setup() {
        if (!api || typeof api.dispatchCustomEvent !== "function") {
            console.warn("[progress-throttle-safe] api.dispatchCustomEvent is unavailable");
            return;
        }

        if (api[PATCH_SLOT]) {
            console.info("[progress-throttle-safe] already active; duplicate copy ignored");
            return;
        }

        // Disable the earlier broad RAF/canvas patch when it is still present.
        // Its wrapper remains as a no-op pass-through, so users should remove the
        // old folder permanently, but this avoids stacking its active behavior.
        try {
            const legacy = window.comfyActiveTabPerformancePatch;
            if (legacy && typeof legacy.disable === "function") {
                legacy.disable();
                console.warn(
                    "[progress-throttle-safe] disabled legacy ActiveTabPerformancePatch; " +
                    "remove the old custom-node folder to avoid stacked wrappers",
                );
            }
        } catch (error) {
            console.warn("[progress-throttle-safe] legacy patch cleanup failed", error);
        }

        if (Object.prototype.hasOwnProperty.call(api, "dispatchCustomEvent")) {
            console.warn(
                "[progress-throttle-safe] another dispatchCustomEvent wrapper is already installed " +
                "(e.g. comfyui-progress-throttle or ActiveTabPerformancePatch). " +
                "Remove old patch folders; stacked wrappers are unsupported.",
            );
        }

        const originalDispatch = api.dispatchCustomEvent;
        const state = {
            enabled: Boolean(CONFIG.enabled),
            sequence: 0,
            activePromptIds: new Set(),
            lastPromptId: null,
            groups: new Map(),
            stats: new Map(),
        };

        function log(...args) {
            if (CONFIG.log) console.log("[progress-throttle-safe]", ...args);
        }

        function callOriginal(type, detail) {
            return Reflect.apply(originalDispatch, api, [type, detail]);
        }

        function stat(type, field, amount = 1) {
            let entry = state.stats.get(type);
            if (!entry) {
                entry = {
                    received: 0,
                    queued: 0,
                    replaced: 0,
                    delivered: 0,
                    passedThrough: 0,
                    terminalFlushes: 0,
                };
                state.stats.set(type, entry);
            }
            entry[field] += amount;
        }

        function getStats() {
            return Object.fromEntries(
                [...state.stats.entries()].map(([type, values]) => [
                    type,
                    { ...values },
                ]),
            );
        }

        function resetStats() {
            state.stats.clear();
        }

        function fallbackPromptId() {
            if (state.activePromptIds.size === 1) {
                return state.activePromptIds.values().next().value ?? null;
            }
            return state.lastPromptId;
        }

        function explicitPromptId(detail) {
            if (!detail || typeof detail !== "object") return null;
            const value = detail.prompt_id ?? detail.promptId ?? detail.jobId;
            return value === undefined || value === null ? null : String(value);
        }

        function resolvedPromptId(detail) {
            return explicitPromptId(detail) ?? fallbackPromptId();
        }

        function groupConfig(type) {
            if (type === "progress" || type === "progress_state") {
                return {
                    name: "progress",
                    intervalMs: clampInterval(CONFIG.progressIntervalMs),
                };
            }
            if (type === "progress_text") {
                return {
                    name: "progress_text",
                    intervalMs: clampInterval(CONFIG.progressTextIntervalMs),
                };
            }
            if (type === "b_preview" || type === "b_preview_with_metadata") {
                return {
                    name: "preview",
                    intervalMs: clampInterval(CONFIG.previewIntervalMs),
                };
            }
            return null;
        }

        function channelKey(type, detail, promptId) {
            const job = promptId ?? "__global__";

            // progress is a single current-node stream per prompt. Keying it by
            // node can let an old node's trailing event arrive after a new node.
            if (type === "progress" || type === "progress_state") {
                return `${type}\u0000${job}`;
            }

            if (type === "progress_text") {
                const node = detail?.nodeId ?? detail?.node ?? "";
                return `${type}\u0000${job}\u0000${String(node)}`;
            }

            if (type === "b_preview_with_metadata") {
                const node =
                    detail?.displayNodeId ?? detail?.nodeId ?? detail?.realNodeId ?? "";
                return `${type}\u0000${job}\u0000${String(node)}`;
            }

            // Legacy b_preview contains only a Blob, so one latest preview per
            // best-known prompt is the safest possible key.
            return `${type}\u0000${job}`;
        }

        function getGroup(name) {
            let group = state.groups.get(name);
            if (!group) {
                group = {
                    name,
                    lastFlushAt: 0,
                    timerId: null,
                    pending: new Map(),
                };
                state.groups.set(name, group);
            }
            return group;
        }

        function currentIntervalForGroup(name) {
            if (name === "progress") return clampInterval(CONFIG.progressIntervalMs);
            if (name === "progress_text") {
                return clampInterval(CONFIG.progressTextIntervalMs);
            }
            if (name === "preview") return clampInterval(CONFIG.previewIntervalMs);
            return 0;
        }

        function clearGroupTimer(group) {
            if (group.timerId !== null) {
                window.clearTimeout(group.timerId);
                group.timerId = null;
            }
        }

        function dispatchItems(items, reason) {
            if (items.length === 0) return;
            items.sort((a, b) => a.sequence - b.sequence);

            for (const item of items) {
                stat(item.type, "delivered");
                if (reason === "terminal") stat(item.type, "terminalFlushes");
                callOriginal(item.type, item.detail);
            }
        }

        function scheduleGroup(group) {
            if (group.timerId !== null || group.pending.size === 0) return;

            const intervalMs = currentIntervalForGroup(group.name);
            if (intervalMs <= 0) {
                flushGroup(group, "disabled-interval");
                return;
            }

            const now = performance.now();
            const dueIn =
                group.lastFlushAt > 0
                    ? Math.max(0, group.lastFlushAt + intervalMs - now)
                    : 0;
            const coalesce = clampInterval(CONFIG.coalesceWindowMs);
            const delay = Math.max(1, dueIn, coalesce);

            group.timerId = window.setTimeout(() => {
                group.timerId = null;
                flushGroup(group, "timer");
            }, delay);
        }

        function flushGroup(group, reason) {
            clearGroupTimer(group);
            if (group.pending.size === 0) return;

            const items = [...group.pending.values()];
            group.pending.clear();
            group.lastFlushAt = performance.now();
            dispatchItems(items, reason);

            // A listener may synchronously enqueue another event while the batch
            // is being dispatched. Do not strand it without a timer.
            if (group.pending.size > 0) scheduleGroup(group);
        }

        function flushWhere(predicate, reason = "manual") {
            const items = [];
            const touchedGroups = new Set();

            for (const group of state.groups.values()) {
                for (const [key, item] of group.pending) {
                    if (!predicate(item)) continue;
                    group.pending.delete(key);
                    items.push(item);
                    touchedGroups.add(group);
                }
            }

            const now = performance.now();
            for (const group of touchedGroups) {
                group.lastFlushAt = now;
                clearGroupTimer(group);
                if (group.pending.size > 0) scheduleGroup(group);
            }

            dispatchItems(items, reason);
        }

        function flushAll(reason = "manual") {
            flushWhere(() => true, reason);
        }

        function flushPrompt(promptId, reason = "terminal") {
            const id = promptId === null ? null : String(promptId);
            flushWhere(
                (item) => id === null || item.promptId === id || item.promptId === null,
                reason,
            );
        }

        function dropWhere(predicate) {
            for (const group of state.groups.values()) {
                let changed = false;
                for (const [key, item] of group.pending) {
                    if (!predicate(item)) continue;
                    group.pending.delete(key);
                    changed = true;
                }
                if (!changed) continue;
                clearGroupTimer(group);
                if (group.pending.size > 0) scheduleGroup(group);
            }
        }

        function dropAll() {
            dropWhere(() => true);
        }

        function shouldThrottle(type) {
            if (!state.enabled) return null;
            if (CONFIG.visibleOnly && document.hidden) return null;
            const info = groupConfig(type);
            if (!info || info.intervalMs <= 0) return null;
            return info;
        }

        function enqueue(type, detail, info) {
            const promptId = resolvedPromptId(detail);
            const group = getGroup(info.name);
            const key = channelKey(type, detail, promptId);
            const replaced = group.pending.has(key);

            group.pending.set(key, {
                type,
                detail,
                promptId,
                sequence: ++state.sequence,
            });

            stat(type, "queued");
            if (replaced) stat(type, "replaced");
            scheduleGroup(group);
            return true;
        }

        function cleanupPrompt(promptId) {
            if (promptId === null) return;
            const id = String(promptId);
            state.activePromptIds.delete(id);
            if (state.lastPromptId === id) {
                state.lastPromptId =
                    state.activePromptIds.size > 0
                        ? [...state.activePromptIds].at(-1) ?? null
                        : null;
            }
        }

        function patchedDispatchCustomEvent(type, detail) {
            stat(type, "received");

            if (type === "execution_start") {
                const promptId = explicitPromptId(detail);
                if (promptId !== null) {
                    // A reused ID must not inherit a delayed payload from an old run.
                    dropWhere((item) => item.promptId === promptId);
                    state.activePromptIds.add(promptId);
                    state.lastPromptId = promptId;
                }
                stat(type, "passedThrough");
                return callOriginal(type, detail);
            }

            if (TERMINAL_EVENTS.has(type)) {
                const promptId = explicitPromptId(detail);
                // Core resets execution state in these handlers. Deliver the final
                // absolute progress snapshot first, never from a later timer.
                flushPrompt(promptId, "terminal");
                stat(type, "passedThrough");
                try {
                    return callOriginal(type, detail);
                } finally {
                    cleanupPrompt(promptId);
                }
            }

            if (type === "executing" && detail == null) {
                // Compatibility with servers/paths that signal completion with
                // executing:null before or without execution_success.
                flushAll("terminal");
                stat(type, "passedThrough");
                try {
                    return callOriginal(type, detail);
                } finally {
                    state.activePromptIds.clear();
                    state.lastPromptId = null;
                }
            }

            if (type === "reconnecting") {
                // A stale delayed update must not be replayed into the new socket
                // session after core has begun recovery.
                dropAll();
                state.activePromptIds.clear();
                state.lastPromptId = null;
                stat(type, "passedThrough");
                return callOriginal(type, detail);
            }

            const info = shouldThrottle(type);
            if (!info) {
                stat(type, "passedThrough");
                return callOriginal(type, detail);
            }

            return enqueue(type, detail, info);
        }

        api.dispatchCustomEvent = patchedDispatchCustomEvent;

        function onVisibilityChange() {
            if (document.hidden) {
                // Bring stores to the latest state before switching to native
                // background-tab behavior.
                flushAll("visibility-hidden");
            }
        }

        function onPageHide() {
            dropAll();
        }

        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("pagehide", onPageHide);

        const controller = {
            config: CONFIG,
            state,

            enable() {
                state.enabled = true;
                log("enabled");
            },

            disable({ flush = true } = {}) {
                if (flush) flushAll("disable");
                else dropAll();
                state.enabled = false;
                log("disabled");
            },

            flush() {
                flushAll("manual");
            },

            setProgressInterval(ms) {
                flushWhere(
                    (item) => item.type === "progress" || item.type === "progress_state",
                    "config-change",
                );
                CONFIG.progressIntervalMs = clampInterval(ms);
                log("progressIntervalMs =", CONFIG.progressIntervalMs);
                return CONFIG.progressIntervalMs;
            },

            setProgressTextInterval(ms) {
                flushWhere(
                    (item) => item.type === "progress_text",
                    "config-change",
                );
                CONFIG.progressTextIntervalMs = clampInterval(ms);
                log("progressTextIntervalMs =", CONFIG.progressTextIntervalMs);
                return CONFIG.progressTextIntervalMs;
            },

            setPreviewInterval(ms) {
                flushWhere(
                    (item) =>
                        item.type === "b_preview" ||
                        item.type === "b_preview_with_metadata",
                    "config-change",
                );
                CONFIG.previewIntervalMs = clampInterval(ms);
                log("previewIntervalMs =", CONFIG.previewIntervalMs);
                return CONFIG.previewIntervalMs;
            },

            getStats,
            resetStats,

            uninstall() {
                flushAll("uninstall");
                state.enabled = false;
                document.removeEventListener("visibilitychange", onVisibilityChange);
                window.removeEventListener("pagehide", onPageHide);

                if (api.dispatchCustomEvent === patchedDispatchCustomEvent) {
                    api.dispatchCustomEvent = originalDispatch;
                } else {
                    console.warn(
                        "[progress-throttle-safe] another extension replaced " +
                        "dispatchCustomEvent after this patch; original method was not restored",
                    );
                }

                try {
                    delete api[PATCH_SLOT];
                } catch {
                    api[PATCH_SLOT] = null;
                }
                if (window[GLOBAL_NAME] === controller) {
                    try {
                        delete window[GLOBAL_NAME];
                    } catch {
                        window[GLOBAL_NAME] = null;
                    }
                }
                log("uninstalled");
            },
        };

        Object.defineProperty(api, PATCH_SLOT, {
            value: controller,
            writable: false,
            configurable: true,
            enumerable: false,
        });
        window[GLOBAL_NAME] = controller;

        log("active", {
            progressIntervalMs: CONFIG.progressIntervalMs,
            progressTextIntervalMs: CONFIG.progressTextIntervalMs,
            previewIntervalMs: CONFIG.previewIntervalMs,
            visibleOnly: CONFIG.visibleOnly,
        });
    },
});


/*
 * Execution Quiet Mode
 *
 * While a prompt is executing, ComfyUI shows CSS animations (workflow-tab
 * spinner `animate-spin`, queue banner spinner, etc.). A running CSS animation
 * forces the browser compositor to produce frames at the display refresh rate
 * for the whole generation, and on a single-GPU setup that compositing
 * competes directly with CUDA inference.
 *
 * This module pauses CSS animations only while a job is running and restores
 * them the moment the job finishes. Transitions are left untouched (they are
 * one-shot and some code depends on transitionend). Optionally it can also
 * pause LiteGraph canvas rendering during execution.
 */
app.registerExtension({
    name: "bismarck.ExecutionQuietMode",

    setup() {
        const QUIET_CONFIG = {
            enabled: true,
            // Also set app.canvas.pause_rendering during execution. Measured as
            // neutral on its own, but on single-GPU setups every skipped paint
            // helps. Progress bars on nodes will not move while enabled.
            pauseCanvas: false,
            log: true,
        };

        const STYLE_ID = "ptsafe-quiet-style";
        const HTML_CLASS = "ptsafe-quiet";
        const running = new Set();
        let canvasWasPaused = null;

        function log(...args) {
            if (QUIET_CONFIG.log) console.log("[quiet-mode]", ...args);
        }

        function ensureStyle() {
            if (document.getElementById(STYLE_ID)) return;
            const el = document.createElement("style");
            el.id = STYLE_ID;
            el.textContent =
                "." + HTML_CLASS + " *, ." + HTML_CLASS + " *::before, ." +
                HTML_CLASS + " *::after { animation-play-state: paused !important; }";
            document.head.appendChild(el);
        }

        function quietOn() {
            if (!QUIET_CONFIG.enabled) return;
            ensureStyle();
            if (!document.documentElement.classList.contains(HTML_CLASS)) {
                document.documentElement.classList.add(HTML_CLASS);
                log("on (css animations paused)");
            }
            if (QUIET_CONFIG.pauseCanvas && window.app?.canvas &&
                canvasWasPaused === null) {
                canvasWasPaused = window.app.canvas.pause_rendering;
                window.app.canvas.pause_rendering = true;
            }
        }

        function quietOff() {
            if (document.documentElement.classList.contains(HTML_CLASS)) {
                document.documentElement.classList.remove(HTML_CLASS);
                log("off");
            }
            if (canvasWasPaused !== null && window.app?.canvas) {
                window.app.canvas.pause_rendering = canvasWasPaused;
                canvasWasPaused = null;
                window.app.canvas.setDirty(true, true);
            }
        }

        function promptIdOf(e) {
            const d = e?.detail;
            const v = d?.prompt_id ?? d?.promptId;
            return v === undefined || v === null ? null : String(v);
        }

        function onStart(e) {
            const id = promptIdOf(e);
            running.add(id ?? "__unknown__");
            quietOn();
        }

        function onEnd(e) {
            const id = promptIdOf(e);
            if (id !== null) running.delete(id);
            else running.clear();
            running.delete("__unknown__");
            if (running.size === 0) quietOff();
        }

        function onExecuting(e) {
            if (e?.detail == null) {
                running.clear();
                quietOff();
            }
        }

        function onReset() {
            running.clear();
            quietOff();
        }

        api.addEventListener("execution_start", onStart);
        api.addEventListener("execution_success", onEnd);
        api.addEventListener("execution_error", onEnd);
        api.addEventListener("execution_interrupted", onEnd);
        api.addEventListener("executing", onExecuting);
        api.addEventListener("reconnecting", onReset);
        window.addEventListener("pagehide", onReset);

        window.comfyExecutionQuietMode = {
            config: QUIET_CONFIG,
            enable() { QUIET_CONFIG.enabled = true; if (running.size) quietOn(); log("enabled"); },
            disable() { QUIET_CONFIG.enabled = false; quietOff(); log("disabled"); },
            setPauseCanvas(v) { QUIET_CONFIG.pauseCanvas = Boolean(v); log("pauseCanvas =", QUIET_CONFIG.pauseCanvas); },
            isActive() { return document.documentElement.classList.contains(HTML_CLASS); },
        };

        log("registered", { pauseCanvas: QUIET_CONFIG.pauseCanvas });
    },
});
