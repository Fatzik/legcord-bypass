const { contextBridge, ipcRenderer } = require("electron");

console.log("Hello from preload.mts");
contextBridge.exposeInMainWorld("cssEditor", {
    get: ipcRenderer.sendSync("editor-getCSS") as string,
    set: (css: string) => ipcRenderer.send("editor-setCSS", css),
});
