import { powerSaveBlocker } from "electron";

let id: number;

export function setPowerSaving(state: boolean) {
    if (state) {
        id = powerSaveBlocker.start("prevent-display-sleep");
    } else {
        powerSaveBlocker.stop(id);
    }
}

export function isPowerSavingEnabled(): boolean {
    return powerSaveBlocker.isStarted(id);
}
