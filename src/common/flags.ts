import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, powerMonitor } from "electron";
import isDev from "electron-is-dev";
import { getConfig } from "./config.js";

interface Preset {
    switches: [string, string?][];
    enableFeatures: string[];
    disableFeatures: string[];
}

// Cache for custom flags to avoid repeated file reads
let customFlagsCache: Preset | null = null;

const performance: Preset = {
    switches: [
        ["enable-gpu-rasterization"],
        ["enable-zero-copy"],
        ["ignore-gpu-blocklist"],
        ["enable-hardware-overlays", "single-fullscreen,single-on-top,underlay"],
        ["force_high_performance_gpu"],
    ],
    enableFeatures: [
        "EnableDrDc",
        "CanvasOopRasterization",
        "BackForwardCache:TimeToLiveInBackForwardCacheInSeconds/300/should_ignore_blocklists/true/enable_same_site/true",
        "ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes",
        "UseSkiaRenderer",
        "WebAssemblyLazyCompilation",
    ],
    disableFeatures: ["Vulkan"],
};

/** Light GPU boost without forcing the discrete GPU — a middle ground. */
const balanced: Preset = {
    switches: [["enable-gpu-rasterization"], ["enable-zero-copy"], ["ignore-gpu-blocklist"]],
    enableFeatures: [
        "CanvasOopRasterization",
        "UseSkiaRenderer",
        "WebAssemblyLazyCompilation",
        "CalculateNativeWinOcclusion",
        "ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes",
    ],
    disableFeatures: ["Vulkan"],
};

/** Reduce RAM / CPU usage at the cost of some visual smoothness. */
const memory: Preset = {
    switches: [
        ["enable-low-end-device-mode"],
        ["enable-low-res-tiling"],
        ["process-per-site"],
        ["renderer-process-limit", "2"],
        ["force_low_power_gpu"],
        ["disk-cache-size", "67108864"], // 64 MB
        ["skia-resource-cache-limit-mb", "64"],
    ],
    enableFeatures: ["CalculateNativeWinOcclusion", "TurnOffStreamingMediaCachingOnBattery"],
    disableFeatures: [],
};

/** Favor voice/video call quality. Platform-specific HW encode is layered on later. */
const voip: Preset = {
    switches: [
        ["enable-gpu-rasterization"],
        ["enable-zero-copy"],
        ["ignore-gpu-blocklist"],
        ["enable-accelerated-video-decode"],
        ["force_high_performance_gpu"],
        ["disable-background-timer-throttling"],
        ["disable-renderer-backgrounding"],
        ["disable-backgrounding-occluded-windows"],
        ["enable-gpu-memory-buffer-video-frames"],
    ],
    enableFeatures: [
        "WebRtcHWDecoding",
        "WebRtcHWEncoding",
        "AcceleratedVideoDecoder",
        "AcceleratedVideoEncoder",
        "ZeroCopyDesktopCapture",
    ],
    disableFeatures: ["UseChromeOSDirectVideoDecoder"],
};

/** Minimize input/render latency; keeps the app hot in the background. */
const latency: Preset = {
    switches: [
        ["enable-gpu-rasterization"],
        ["enable-zero-copy"],
        ["ignore-gpu-blocklist"],
        ["force_high_performance_gpu"],
        ["enable-hardware-overlays", "single-fullscreen,single-on-top,underlay"],
        ["disable-background-timer-throttling"],
        ["disable-renderer-backgrounding"],
        ["disable-backgrounding-occluded-windows"],
        ["disable-ipc-flooding-protection"],
        ["disable-backing-store-limit"],
    ],
    enableFeatures: ["EnableDrDc", "CanvasOopRasterization", "UseSkiaRenderer", "WebAssemblyLazyCompilation"],
    disableFeatures: ["Vulkan"],
};

const smoothExperiment: Preset = {
    switches: [
        ["enable-gpu-rasterization"],
        ["enable-zero-copy"],
        ["ignore-gpu-blocklist"],
        ["enable-accelerated-video-decode"],
        ["disable-background-timer-throttling"],
        ["disable-renderer-backgrounding"],
        ["enable-hardware-overlays", "single-fullscreen,single-on-top,underlay"],
        ["force_high_performance_gpu"],
        // Do NOT set use-gl=desktop here. On Electron 43+/macOS, Chromium only allows
        // ANGLE (metal/opengl); use-gl=desktop fails GPU init and then disables all
        // HW acceleration (including VideoToolbox encode) after repeated crashes.
    ],
    enableFeatures: [
        "EnableDrDc",
        "CanvasOopRasterization",
        "BackForwardCache:TimeToLiveInBackForwardCacheInSeconds/300/should_ignore_blocklists/true/enable_same_site/true",
        "ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes",
        "UseSkiaRenderer",
        "WebAssemblyLazyCompilation",
        "WebRtcHWEncoding",
        "WebRtcHWDecoding",
        "AcceleratedVideoEncoder",
        "AcceleratedVideoDecoder",
        "ZeroCopyDesktopCapture",
    ],
    disableFeatures: ["Vulkan", "UseChromeOSDirectVideoDecoder"],
};

const battery: Preset = {
    // Known to have better battery life for Chromium?
    switches: [
        ["force_low_power_gpu"],
        ["enable-low-end-device-mode"],
        ["enable-low-res-tiling"],
        ["process-per-site"],
    ],
    enableFeatures: ["TurnOffStreamingMediaCachingOnBattery", "CalculateNativeWinOcclusion"],
    disableFeatures: [],
};

/**
 * Shared WebRTC / screenshare baseline (no platform encode backend).
 * Encode is added by macVideoToolbox / winVideoEncode / linux vaapi|software.
 */
const webrtcHwCommon: Preset = {
    switches: [
        ["ignore-gpu-blocklist"],
        ["enable-zero-copy"],
        ["enable-accelerated-video-decode"],
        ["enable-gpu-memory-buffer-video-frames"],
    ],
    enableFeatures: ["WebRtcHWDecoding", "AcceleratedVideoDecoder", "ZeroCopyDesktopCapture", "CanvasOopRasterization"],
    disableFeatures: ["UseChromeOSDirectVideoDecoder"],
};

/** Windows Media Foundation / Chromium HW encode path. */
const winVideoEncode: Preset = {
    switches: [
        // Legacy Chromium switches still honored by Electron's WebRTC stack
        ["webrtc-hw-encoding"],
        ["webrtc-hw-decoding"],
    ],
    enableFeatures: [
        "WebRtcHWEncoding",
        "AcceleratedVideoEncoder",
        // Off by default on Windows; without it CBP (Discord's 42e01f) stays on OpenH264.
        // SDP munge prefers Baseline, but keep CBP HW as a fallback if negotiation reverts.
        "PlatformH264CbpEncoding",
    ],
    disableFeatures: [],
};

/**
 * Linux: force software OpenH264 encode when VAAPI is off.
 * AMD VCE via VaapiVideoEncodeAccelerator can freeze Discord screenshare for viewers
 * even when chrome://gpu lists encode profiles.
 */
const linuxSoftwareVideoEncode: Preset = {
    switches: [],
    enableFeatures: [],
    disableFeatures: ["AcceleratedVideoEncoder", "VaapiVideoEncoder", "WebRtcHWEncoding"],
};

/** macOS VideoToolbox HW encode/decode (Intel + Apple Silicon). */
const macVideoToolbox: Preset = {
    switches: [
        ["ignore-gpu-blocklist"],
        // After use-gl=desktop / other GPU init failures, Chromium may keep GPU disabled
        // due to "frequent crashes" even once the bad flag is gone — clear that limit.
        ["disable-gpu-process-crash-limit"],
        ["enable-zero-copy"],
        ["enable-accelerated-video-decode"],
        // Legacy Chromium switches still honored by Electron's WebRTC stack
        ["webrtc-hw-encoding"],
        ["webrtc-hw-decoding"],
        ["enable-gpu-memory-buffer-video-frames"],
    ],
    enableFeatures: [
        "MacosVideoToolbox",
        "VideoToolboxVideoDecoder",
        "WebRtcHWEncoding",
        "WebRtcHWDecoding",
        "AcceleratedVideoEncoder",
        "AcceleratedVideoDecoder",
        "ZeroCopyDesktopCapture",
        // Helps enumerate platform HW encoders used by WebRTC on Apple GPUs
        "PlatformHEVCEncoderSupport",
    ],
    disableFeatures: [],
};

/** Linux VA-API encode/decode (only applied when vaapi setting is on). */
const linuxVaapi: Preset = {
    switches: [
        ["ignore-gpu-blocklist"],
        ["disable-gpu-process-crash-limit"],
        ["enable-gpu-rasterization"],
        ["enable-zero-copy"],
        ["enable-accelerated-video-decode"],
        ["force_high_performance_gpu"],
        // ANGLE+OpenGL required for AcceleratedVideoDecodeLinuxGL on Wayland.
        // Do NOT use use-gl=desktop (removed in Electron 43+ / breaks GPU init).
        ["use-gl", "angle"],
        ["use-angle", "gl"],
        ["enable-gpu-memory-buffer-video-frames"],
    ],
    enableFeatures: [
        "VaapiIgnoreDriverChecks",
        "VaapiVideoDecoder",
        "VaapiVideoEncoder",
        "AcceleratedVideoEncoder",
        "AcceleratedVideoDecoder",
        "AcceleratedVideoDecodeLinuxGL",
        "AcceleratedVideoDecodeLinuxZeroCopyGL",
        "WebRtcHWEncoding",
        "WebRtcHWDecoding",
        "ZeroCopyDesktopCapture",
        "CanvasOopRasterization",
    ],
    // Vulkan is incompatible with ozone wayland and breaks VAAPI GL interop.
    disableFeatures: ["UseChromeOSDirectVideoDecoder", "Vulkan"],
};

/**
 * Fedora/RPM Fusion ships H.264/HEVC VA-API in dri-freeworld (patent-encumbered), while
 * stock /usr/lib64/dri only exposes MPEG2/JPEG. Prefer freeworld so chrome://gpu lists
 * real encode/decode profiles instead of an empty Video Acceleration Information block.
 */
export function configureLinuxVaapiEnvironment(): void {
    if (process.platform !== "linux") return;

    const candidates = [
        "/usr/lib64/dri-freeworld",
        "/usr/lib64/dri-nonfree",
        "/usr/lib/dri-freeworld",
        "/usr/lib/dri-nonfree",
    ];
    const preferred = candidates.filter((dir) => existsSync(dir));
    if (preferred.length === 0) return;

    const stock = ["/usr/lib64/dri", "/usr/lib/dri"].filter((dir) => existsSync(dir));
    const parts = [...preferred, ...stock];
    const existing = process.env.LIBVA_DRIVERS_PATH;
    process.env.LIBVA_DRIVERS_PATH = existing ? `${parts.join(":")}:${existing}` : parts.join(":");
    console.log(`VAAPI: using LIBVA_DRIVERS_PATH=${process.env.LIBVA_DRIVERS_PATH}`);
}

/** Strip Linux encode features that shared presets may have enabled. */
function withoutLinuxHwEncode(preset: Preset): Preset {
    const block = new Set(["AcceleratedVideoEncoder", "VaapiVideoEncoder", "WebRtcHWEncoding"]);
    return {
        switches: preset.switches,
        enableFeatures: preset.enableFeatures.filter((f) => !block.has(f)),
        disableFeatures: [...new Set([...preset.disableFeatures, ...block])],
    };
}

/**
 * Apply the platform-tested WebRTC / screenshare encode+decode stack.
 * macOS → VideoToolbox; Windows → Chromium HW encode; Linux → VAAPI toggle.
 */
function applyPlatformVideoStack(base: Preset | undefined): Preset | undefined {
    if (!getConfig("hardwareAcceleration")) return base;

    const preset = base ? mergePresets(base, webrtcHwCommon) : webrtcHwCommon;
    console.log("WebRTC HW baseline enabled");

    switch (process.platform) {
        case "darwin":
            console.log("macOS VideoToolbox HW encode/decode flags enabled");
            return mergePresets(preset, macVideoToolbox);
        case "win32":
            console.log("Windows HW video encode flags enabled");
            return mergePresets(preset, winVideoEncode);
        case "linux":
            if (getConfig("vaapi")) {
                console.log("Linux VAAPI HW encode/decode flags enabled");
                configureLinuxVaapiEnvironment();
                return mergePresets(preset, linuxVaapi);
            }
            console.log("Linux VAAPI off — forcing software WebRTC video encode");
            return withoutLinuxHwEncode(mergePresets(preset, linuxSoftwareVideoEncode));
        default:
            // Other Unix-likes: keep decode baseline; enable generic HW encode.
            return mergePresets(preset, winVideoEncode);
    }
}

/**
 * Load custom flags from JSON file in user data directory (cached after first load)
 * Path:
 *   - Windows: %APPDATA%\legcord\flags.json (typically C:\Users\{username}\AppData\Roaming\legcord\flags.json)
 *   - macOS: ~/Library/Application Support/legcord/flags.json
 *   - Linux: ~/.config/legcord/flags.json
 * Returns an empty preset if file doesn't exist or is invalid
 */
function loadCustomFlags(): Preset {
    // Return cached result to avoid repeated disk reads
    if (customFlagsCache !== null) {
        return customFlagsCache;
    }

    const customPreset: Preset = {
        switches: [],
        enableFeatures: [],
        disableFeatures: [],
    };

    try {
        const userDataPath = app.getPath("userData");
        const customFlagsPath = join(userDataPath, "flags.json");

        try {
            const fileContent = readFileSync(customFlagsPath, "utf-8");
            const customFlags = JSON.parse(fileContent);

            // Merge switches
            if (Array.isArray(customFlags.switches)) {
                customPreset.switches = customFlags.switches;
            }

            // Merge enableFeatures
            if (Array.isArray(customFlags.enableFeatures)) {
                customPreset.enableFeatures = customFlags.enableFeatures;
            }

            // Merge disableFeatures
            if (Array.isArray(customFlags.disableFeatures)) {
                customPreset.disableFeatures = customFlags.disableFeatures;
            }

            if (isDev) console.log(`Custom flags loaded from ${customFlagsPath}`);
        } catch (fileError) {
            if ((fileError as NodeJS.ErrnoException).code === "ENOENT") {
                if (isDev) console.log(`Custom flags file not found at ${customFlagsPath}`);
            } else if (isDev) {
                console.error(`Error reading custom flags file: ${fileError}`);
            }
        }
    } catch (error) {
        if (isDev) console.error(`Error loading custom flags: ${error}`);
    }

    customFlagsCache = customPreset;
    return customPreset;
}

/**
 * Merge a preset with custom flags
 * Custom flags will be appended to the preset's arrays
 */
function mergeWithCustomFlags(preset: Preset): Preset {
    const customFlags = loadCustomFlags();

    return {
        switches: [...preset.switches, ...customFlags.switches],
        enableFeatures: [...preset.enableFeatures, ...customFlags.enableFeatures],
        disableFeatures: [...preset.disableFeatures, ...customFlags.disableFeatures],
    };
}

function mergePresets(base: Preset, extra: Preset): Preset {
    return {
        switches: [...base.switches, ...extra.switches],
        enableFeatures: [...base.enableFeatures, ...extra.enableFeatures],
        disableFeatures: [...base.disableFeatures, ...extra.disableFeatures],
    };
}

export function getPreset(): Preset | undefined {
    //     MIT License

    // Copyright (c) 2022 GooseNest

    // Permission is hereby granted, free of charge, to any person obtaining a copy
    // of this software and associated documentation files (the "Software"), to deal
    // in the Software without restriction, including without limitation the rights
    // to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    // copies of the Software, and to permit persons to whom the Software is
    // furnished to do so, subject to the following conditions:

    // The above copyright notice and this permission notice shall be included in all
    // copies or substantial portions of the Software.

    // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    // FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    // AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    // LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    // OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    // SOFTWARE.
    let preset: Preset | undefined;

    switch (getConfig("performanceMode")) {
        case "dynamic":
            if (powerMonitor.isOnBatteryPower()) {
                console.log("Battery mode enabled");
                preset = battery;
            } else {
                console.log("Performance mode enabled");
                preset = performance;
            }
            break;
        case "performance":
            console.log("Performance mode enabled");
            preset = performance;
            break;
        case "balanced":
            console.log("Balanced mode enabled");
            preset = balanced;
            break;
        case "battery":
            console.log("Battery mode enabled");
            preset = battery;
            break;
        case "memory":
            console.log("Memory saver mode enabled");
            preset = memory;
            break;
        case "voip":
            console.log("Voice & video mode enabled");
            preset = voip;
            break;
        case "latency":
            console.log("Low latency mode enabled");
            preset = latency;
            break;
        case "smoothScreenshare":
            console.log("Smooth screenshare mode enabled");
            preset = smoothExperiment;
            break;
        default:
            console.log("No performance modes set");
    }

    // Platform-specific video encode/decode (macOS VideoToolbox / Win HW / Linux VAAPI).
    // Shared voip/smoothScreenshare presets must not carry Linux-only or cross-platform
    // encode flags that would undermine the macOS stack we just fixed.
    preset = applyPlatformVideoStack(preset);

    if (preset) {
        return mergeWithCustomFlags(preset);
    }
}

/**
 * Get the currently applied preset for debugging purposes
 */
export function getCurrentPreset(): Preset | undefined {
    return getPreset();
}
