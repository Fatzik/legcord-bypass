import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

export interface LaunchIpcStatus {
    state: string;
    detail: string;
}

const launch = ipcRenderer.sendSync("splash-launch") as LaunchIpcStatus;

contextBridge.exposeInMainWorld("internal", {
    restart: () => ipcRenderer.send("restart"),
    version: ipcRenderer.sendSync("get-app-version", "app-version") as string,
    isDev: ipcRenderer.sendSync("splash-isDev") as string,
    isMicrosoftStore: ipcRenderer.sendSync("splash-isMicrosoftStore") as string,
    mods: ipcRenderer.sendSync("splash-clientmod") as string,
    getLang: (toGet: string) =>
        ipcRenderer.invoke("getLang", toGet).then((result: string) => {
            return result;
        }),
    splashEnd: () => ipcRenderer.send("splashEnd"),
    launch,
    onLaunchStatus: (callback: (status: LaunchIpcStatus) => void) => {
        const handler = (_event: IpcRendererEvent, status: LaunchIpcStatus) => {
            callback(status);
        };
        ipcRenderer.on("launch-status", handler);
        return () => ipcRenderer.removeListener("launch-status", handler);
    },
});
