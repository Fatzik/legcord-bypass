/**
 * Main process entry example.
 * Receives api from Legcord plugin manager.
 */
module.exports.activate = (api) => {
    api.logger.log("main entry active");

    // Example: patch BrowserWindow.getTitle globally in main process.
    const unpatch = api.patcher.after("getTitle", api.electron.BrowserWindow.prototype, (_args, ret) => {
        if (typeof ret === "string" && !ret.endsWith(" [HelloPlugin]")) {
            return `${ret} [HelloPlugin]`;
        }
        return ret;
    });

    api.onCleanup(() => {
        unpatch();
        api.logger.log("main entry cleaned up");
    });
};
