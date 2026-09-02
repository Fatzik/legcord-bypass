export type LaunchState = "loading-discord" | "ok" | "fail";

export interface LaunchStatus {
    state: LaunchState;
    detail: string;
}

let last: LaunchStatus = { state: "loading-discord", detail: "" };
const listeners = new Set<(status: LaunchStatus) => void>();

export function emitLaunchStatus(state: LaunchState, detail = ""): void {
    last = { state, detail };
    for (const listener of listeners) listener(last);
}

export function getLaunchStatus(): LaunchStatus {
    return last;
}

export function onLaunchStatus(cb: (status: LaunchStatus) => void): () => void {
    listeners.add(cb);
    cb(last);
    return () => listeners.delete(cb);
}
