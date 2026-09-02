import type { BrowserWindow } from "electron";
import { getConfig, getStartMinimizedMode } from "./config.js";

/** Show the main window and restore taskbar/dock presence after a tray-only start. */
export function revealWindow(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    win.setSkipTaskbar(false);
    if (win.isMinimized()) win.restore();
    win.show();
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
            win.show();
            break;
    }
}
