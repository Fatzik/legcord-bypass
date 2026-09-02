import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import isDev from "electron-is-dev";
import { getBypassSnapshot, isBypassEnabled, onBypassUpdate } from "../common/bypass/engine.js";
import { getConfig, isBackgroundStart } from "../common/config.js";
import { getLang } from "../common/lang.js";
import { getLaunchStatus, onLaunchStatus } from "../common/startupBus.js";

export let splashWindow: BrowserWindow;
export async function createSplashWindow(): Promise<void> {
    if (isBackgroundStart()) return;
    splashWindow = new BrowserWindow({
        width: 300,
        height: 350,
        title: getLang("splash-title"),
        show: true,
        darkTheme: true,
        icon: getConfig("customIcon") ?? path.join(import.meta.dirname, "../", "/assets/desktop.png"),
        frame: false,
        backgroundColor: "#202225",
        autoHideMenuBar: true,
        webPreferences: {
            sandbox: false,
            preload: path.join(import.meta.dirname, "splash", "preload.mjs"),
        },
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
    ipcMain.on("splash-bypass", (event) => {
        event.returnValue = {
            enabled: isBypassEnabled(),
            snapshot: getBypassSnapshot(),
        };
    });
    ipcMain.on("splash-launch", (event) => {
        event.returnValue = getLaunchStatus();
    });
    onBypassUpdate((snapshot) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send("bypass-status", snapshot);
        }
    });
    onLaunchStatus((status) => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.webContents.send("launch-status", status);
        }
    });
    await splashWindow.loadURL("legcord://html/splash.html");
}
