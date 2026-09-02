export type BypassStage =
    | "disabled"
    | "checking"
    | "installing"
    | "testing"
    | "activating"
    | "direct"
    | "active"
    | "error";

export interface BypassSnapshot {
    stage: BypassStage;
    detail: string;
    strategy: string;
    tried: number;
    total: number;
}

export interface BypassStrategy {
    id: string;
    label: string;
    /** Build the winws.exe argv (without the executable) from the runtime dir. */
    args: (dir: string) => string[];
}

export type BypassUpdate = (snapshot: BypassSnapshot) => void;
