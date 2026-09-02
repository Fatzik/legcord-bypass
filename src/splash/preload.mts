import { contextBridge, type IpcRendererEvent, ipcRenderer } from "electron";

export interface BypassIpcSnapshot {
    stage: string;
    detail: string;
    strategy: string;
    tried: number;
    total: number;
}

const bypass = ipcRenderer.sendSync("splash-bypass") as {
    enabled: boolean;
    snapshot: BypassIpcSnapshot;
};

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
    bypass,
    onBypassStatus: (callback: (snapshot: BypassIpcSnapshot) => void) => {
        const handler = (_event: IpcRendererEvent, snapshot: BypassIpcSnapshot) => {
            callback(snapshot);
        };
        ipcRenderer.on("bypass-status", handler);
        return () => ipcRenderer.removeListener("bypass-status", handler);
    },
});
