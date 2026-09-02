const {
    util: { log },
    flux: { dispatcher },
} = shelter;

function track(payload: { event: string; properties: { enabled: string } }) {
    if (payload.event === "join_voice_channel") {
        window.legcord.power.setPowerSaving(true);
    } else if (payload.event === "leave_voice_channel") {
        window.legcord.power.setPowerSaving(false);
    }
}

export function onLoad() {
    const settings = window.legcord.settings.getConfig();
    if (!settings.blockPowerSavingInVoiceChat) return;
    log("Legcord Power Integration");
    dispatcher.subscribe("TRACK", track);
}
