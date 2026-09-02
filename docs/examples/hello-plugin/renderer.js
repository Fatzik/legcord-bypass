/**
 * Renderer entry example.
 * Runs in the Discord page context.
 *
 * In renderer entries, expose activate function through module.exports.
 */
module.exports.activate = (api) => {
    api.logger.log("renderer entry active");

    // Example: patch console.log in renderer just to show before/instead/after usage.
    const unpatchBefore = api.patcher.before("log", console, (args) => {
        args.unshift("[HelloPlugin]");
    });

    const unpatchAfter = api.patcher.after("log", console, (_args, ret) => ret);
    void unpatchBefore;
    void unpatchAfter;
};
