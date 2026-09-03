import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import isDev from "electron-is-dev";
import { getConfig, isBackgroundStart } from "../common/config.js";
import { getLang } from "../common/lang.js";
import { acceptCustomProxy, onProxyPhase } from "../common/proxySwitcher.js";
import { getLaunchStatus, onLaunchStatus } from "../common/startupBus.js";
import { fadeInWindow } from "../common/windowVisibility.js";

export let splashWindow: BrowserWindow;
export async function createSplashWindow(): Promise<void> {
    if (isBackgroundStart()) return;
    if (splashWindow && !splashWindow.isDestroyed()) return;
    splashWindow = new BrowserWindow({
        width: 300,
        height: 360,
        title: getLang("splash-title"),
        show: false,
        darkTheme: true,
        icon: getConfig("customIcon") ?? path.join(import.meta.dirname, "../", "/assets/desktop.png"),
        frame: false,
        backgroundColor: "#05060a",
        autoHideMenuBar: true,
        webPreferences: {
            sandbox: false,
            preload: path.join(import.meta.dirname, "splash", "preload.mjs"),
        },
    });
    splashWindow.once("ready-to-show", () => {
        // Smooth appearance instead of a hard pop.
        fadeInWindow(splashWindow, 350);
    });
    ipcMain.on("splash-isDev", (event) => {
        event.returnValue = isDev;
    });
    ipcMain.on("splash-isMicrosoftStore", (event) => {
        event.returnValue = process.windowsStore;
    });
    ipcMain.on("splash-clientmod", (event) => {
        event.returnValue = getConfig("mods");
    });
    ipcMain.on("splash-launch", (event) => {
        event.returnValue = getLaunchStatus();
    });
    ipcMain.on("splash-launch-now", (event) => {
        event.returnValue = getLaunchStatus();
    });
    ipcMain.handle("splash-accept-proxy", (_event, raw: string) => acceptCustomProxy(String(raw ?? "")));
    onLaunchStatus((status) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send("launch-status", status);
        }
    });
    onProxyPhase((text) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send("proxy-phase", text);
        }
    });
    await splashWindow.loadURL("legcord://html/splash.html");
}
