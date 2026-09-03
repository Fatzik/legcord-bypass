import type { BrowserWindow } from "electron";
import { getConfig, getStartMinimizedMode } from "./config.js";

function opacitySupported(): boolean {
    return process.platform === "win32" || process.platform === "darwin";
}

/**
 * Smoothly fade a window in (used for the splash and for the first reveal of
 * the Discord window). Falls back to an instant show where opacity is unsupported.
 */
export function fadeInWindow(win: BrowserWindow, durationMs = 500): void {
    if (win.isDestroyed()) return;
    if (!opacitySupported()) {
        win.show();
        return;
    }
    try {
        win.setOpacity(0);
    } catch {
        win.show();
        return;
    }
    if (!win.isVisible()) win.show();
    const started = Date.now();
    const timer = setInterval(() => {
        if (win.isDestroyed()) {
            clearInterval(timer);
            return;
        }
        const progress = Math.min(1, (Date.now() - started) / durationMs);
        try {
            win.setOpacity(progress);
        } catch {
            clearInterval(timer);
            return;
        }
        if (progress >= 1) clearInterval(timer);
    }, 16);
}

/** Show the main window and restore taskbar/dock presence after a tray-only start. */
export function revealWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    fadeInWindow(win, 300);
    win.focus();
}

/** Apply startMinimized mode when splash will not call splashEnd, or from splashEnd itself. */
export function applyStartupWindowVisibility(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    const mode = getStartMinimizedMode();
    switch (mode) {
        case "minimized":
            win.setSkipTaskbar(false);
            win.show();
            win.minimize();
            break;
        case "tray":
            if (getConfig("tray") === "disabled") {
                console.warn(
                    '[Window] startMinimized is "tray" but the tray icon is disabled; the window will be hidden with no tray.',
                );
            }
            win.setSkipTaskbar(true);
            win.hide();
            break;
        default:
            win.setSkipTaskbar(false);
            fadeInWindow(win, 500);
            break;
    }
}
