/**
 * Preload entry example.
 * Runs in Legcord preload context with access to DOM and plugin API.
 */
module.exports.activate = (api) => {
    api.logger.log("preload entry active");

    // Example: patch document title setter for demonstration.
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, "title");
    if (!descriptor?.set) return;

    const patchTarget = { setTitle: descriptor.set };
    const unpatch = api.patcher.before("setTitle", patchTarget, (args) => {
        if (typeof args[0] === "string" && !args[0].includes("[P]")) {
            args[0] = `[P] ${args[0]}`;
        }
    });

    Object.defineProperty(document, "title", {
        configurable: true,
        get: descriptor.get?.bind(document),
        set: (value) => patchTarget.setTitle.call(document, value),
    });

    api.onCleanup(() => {
        unpatch();
        api.logger.log("preload entry cleaned up");
    });
};
