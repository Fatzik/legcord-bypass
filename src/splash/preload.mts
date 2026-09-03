import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

export interface LaunchIpcStatus {
    state: string;
    detail: string;
}

const launch = ipcRenderer.sendSync("splash-launch") as LaunchIpcStatus;

contextBridge.exposeInMainWorld("internal", {
    restart: () => ipcRenderer.send("restart"),
    isDev: ipcRenderer.sendSync("splash-isDev") as string,
    isMicrosoftStore: ipcRenderer.sendSync("splash-isMicrosoftStore") as string,
    mods: ipcRenderer.sendSync("splash-clientmod") as string,
    getLang: (toGet: string) =>
        ipcRenderer.invoke("getLang", toGet).then((result: string) => {
            return result;
        }),
    splashEnd: () => ipcRenderer.send("splashEnd"),
    acceptProxy: (value: string) =>
        ipcRenderer.invoke("splash-accept-proxy", value) as Promise<{
            ok: boolean;
            url: string;
            ms: number;
            error?: string;
        }>,
    launch,
    getLaunchStatus: () => ipcRenderer.sendSync("splash-launch-now") as LaunchIpcStatus,
    onProxyPhase: (callback: (text: string) => void) => {
        const handler = (_event: IpcRendererEvent, text: string) => {
            callback(text);
        };
        ipcRenderer.on("proxy-phase", handler);
        return () => ipcRenderer.removeListener("proxy-phase", handler);
    },
    onLaunchStatus: (callback: (status: LaunchIpcStatus) => void) => {
        const handler = (_event: IpcRendererEvent, status: LaunchIpcStatus) => {
            callback(status);
        };
        ipcRenderer.on("launch-status", handler);
        return () => ipcRenderer.removeListener("launch-status", handler);
    },
});
