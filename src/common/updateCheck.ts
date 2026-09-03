import { Notification } from "electron";
import { getVersion } from "./version.js";

const CHECK_URL = "https://legcord.app/latest.json";
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 12000;

const log = (message: string): void => console.log(`[Updater] ${message}`);

async function checkForUpdates(manual = false): Promise<void> {
    try {
        const response = await fetch(CHECK_URL, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return;
        const data = (await response.json()) as { version?: string };
        const remote = data.version;
        if (!remote) return;
        const localClean = getVersion().replace(/\./g, "");
        const remoteClean = remote.replace(/\./g, "");
        if (Number(remoteClean) <= Number(localClean)) return;

        log(`new LegCord version available: ${remote} (current ${getVersion()})`);
        if (manual || Notification.isSupported()) {
            const notification = new Notification({
                title: "LegCord Bypass — новая версия",
                body: `Доступна версия ${remote}. Обновление скачается/установится при следующем релизе в GitHub.`,
            });
            notification.show();
        }
    } catch {
        if (manual) log("update check failed (network/proxy unavailable)");
    }
}

let started = false;

/** Periodically check for a newer LegCord release. Discord itself is a web app and updates automatically. */
export function startUpdateWatcher(): void {
    if (started) return;
    started = true;
    setTimeout(() => {
        void checkForUpdates();
        setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
    }, INITIAL_DELAY_MS);
}

export { checkForUpdates };
