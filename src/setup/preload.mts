const { contextBridge, ipcRenderer } = require("electron");

import type { Settings } from "../@types/settings.js";

contextBridge.exposeInMainWorld("setup", {
    restart: () => ipcRenderer.send("setup-restart"),
    os: ipcRenderer.sendSync("setup-getOS") as string,
    saveSettings: (...args: [Settings]) => ipcRenderer.send("setup-saveSettings", ...args),
    getLang: (toGet: string) =>
        ipcRenderer.invoke("setup-getLang", toGet).then((result: string) => {
            return result;
        }),
    getRawLang: () => ipcRenderer.invoke("setup-getRawLang") as Promise<Record<string, string>>,
});

if (ipcRenderer.sendSync("setup-getOS") !== "darwin") {
    document.addEventListener("DOMContentLoaded", () => {
        document.body.classList.add("has-setup-bg");
    });
}

declare global {
    interface Window {
        setup: {
            // biome-ignore lint/suspicious/noExplicitAny: needed for settings payload
            saveSettings: (settings: any) => void;
            restart: () => void;
            os: string;
            getLang: (toGet: string) => Promise<string>;
            getRawLang: () => Promise<Record<string, string>>;
        };
    }
}
