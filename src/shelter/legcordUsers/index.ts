/// <reference path="../../../node_modules/@uwu/shelter-defs/dist/shelter-defs/rootdefs.d.ts" />

const {
    util: { log },
    flux: { dispatcher },
} = shelter;

/**
 * Опознавательный маркер LegCord (включён по умолчанию).
 *
 * Маяк: каждый запущенный LegCord-клиент сам транслирует активность с нашим
 * application_id, поэтому его видно другим LegCord-клиентам. Выключить:
 *   window.legcordUsersBeacon(false)
 * Включить обратно:
 *   window.legcordUsersBeacon(true)
 */
const MARKER_NAME = "LegCord";
const MARKER_APP_ID = "1294003123519467661";
const BEACON_INTERVAL_MS = 45000;

const MESSAGE_USERNAME_SELECTOR = '[id^="message-username-"]';
const SETTINGS_SELECTOR = '[class*="standardSidebarView"], [aria-label="User Settings"], [aria-label="USER_SETTINGS"]';

const marked = new Set<string>();
const online = new Set<string>();

let beaconEnabled = true;
let beaconTimer: number | null = null;
let styleElement: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let rescanTimer: number | null = null;
let refreshTimer: number | null = null;
let interval: number | null = null;
let chipTimer: number | null = null;
let chip: HTMLDivElement | null = null;

function isLegCordActivity(activity: unknown): boolean {
    if (!activity || typeof activity !== "object") return false;
    const a = activity as { application_id?: string | number; name?: string; details?: string; state?: string };
    const appId = String(a.application_id ?? "");
    if (appId !== "" && appId === MARKER_APP_ID) return true;
    const haystack = [a.name, a.details, a.state]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
    return haystack.includes("legcord");
}

function hasLegCordActivity(activities: unknown): boolean {
    return Array.isArray(activities) && activities.some((activity) => isLegCordActivity(activity as never));
}

function updateUser(userId: string, active: boolean): void {
    const id = String(userId);
    const wasOnline = online.has(id);
    if (active) {
        if (!marked.has(id)) {
            marked.add(id);
            scheduleRescan();
        }
        online.add(id);
    } else {
        if (marked.delete(id)) scheduleRescan();
        online.delete(id);
    }
    if (wasOnline !== online.has(id)) updateChip();
}

function applyPresence(presence: { user?: { id?: string }; activities?: unknown; status?: string } | undefined): void {
    if (!presence?.user?.id) return;
    const offline = presence.status === "offline" || presence.status === "invisible";
    const active = !offline && hasLegCordActivity(presence.activities);
    updateUser(presence.user.id, active);
}

function onPresenceUpdate(payload: { user?: { id?: string }; activities?: unknown; status?: string }): void {
    applyPresence(payload);
}

function onGuildCreate(payload: { presences?: Array<{ user?: { id?: string }; activities?: unknown; status?: string }> }): void {
    for (const presence of payload.presences ?? []) applyPresence(presence);
}

function onGuildMembersChunk(payload: { presences?: Array<{ user?: { id?: string }; activities?: unknown; status?: string }> }): void {
    for (const presence of payload.presences ?? []) applyPresence(presence);
}

function userIdFromMessageUsername(element: Element): string | null {
    const id = element.getAttribute("id") ?? "";
    const prefix = "message-username-";
    if (!id.startsWith(prefix)) return null;
    const userId = id.slice(prefix.length);
    return userId.length > 0 && /^\d+$/.test(userId) ? userId : null;
}

function collectNameTargets(): Array<{ el: Element; uid: string }> {
    const targets = new Map<Element, string>();
    for (const el of document.querySelectorAll(MESSAGE_USERNAME_SELECTOR)) {
        const uid = userIdFromMessageUsername(el);
        if (uid !== null) targets.set(el, uid);
    }
    // Member list rows, DM rows, member popouts etc. expose data-user-id on the row.
    for (const row of document.querySelectorAll("[data-user-id]")) {
        const uid = String(row.getAttribute("data-user-id") ?? "");
        if (!/^\d+$/.test(uid)) continue;
        const nameEl = row.querySelector('[class*="username"]');
        if (nameEl && nameEl !== row) targets.set(nameEl, uid);
    }
    return Array.from(targets.entries()).map(([el, uid]) => ({ el, uid }));
}

function applyMarkToElement(el: Element, uid: string): void {
    if (marked.has(uid)) {
        el.classList.add("lcu-legcord");
        el.setAttribute("data-lcu-user", uid);
    } else {
        el.classList.remove("lcu-legcord");
        el.removeAttribute("data-lcu-user");
    }
}

function rescan(): void {
    for (const { el, uid } of collectNameTargets()) applyMarkToElement(el, uid);
}

function scheduleRescan(): void {
    if (rescanTimer !== null) return;
    rescanTimer = window.setTimeout(() => {
        rescanTimer = null;
        rescan();
    }, 300);
}

function injectStyles(): void {
    if (styleElement) return;
    styleElement = document.createElement("style");
    styleElement.textContent = `
        .lcu-legcord {
            position: relative;
            cursor: help;
            transition: background-color 0.15s ease;
        }

        .lcu-legcord::after {
            content: "";
            display: inline-block;
            width: 6px;
            height: 6px;
            margin-left: 4px;
            border-radius: 50%;
            vertical-align: middle;
            background: linear-gradient(135deg, #5865f2, #eb459e, #f9c835);
            box-shadow: 0 0 5px rgba(235, 69, 158, 0.5);
            flex: 0 0 auto;
        }

        .lcu-legcord:hover {
            background-color: rgba(114, 137, 218, 0.12);
            border-radius: 3px;
        }

        #lcu-online-chip {
            position: fixed;
            right: 14px;
            bottom: 14px;
            z-index: 2147483001;
            display: flex;
            align-items: center;
            gap: 7px;
            padding: 6px 12px;
            border-radius: 999px;
            background: rgba(14, 16, 20, 0.85);
            border: 1px solid rgba(114, 137, 218, 0.35);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
            font-family: "Segoe UI", "Whitney", sans-serif;
            font-size: 12px;
            line-height: 1;
            color: #dcddde;
            pointer-events: none;
            user-select: none;
        }

        #lcu-online-chip .lcu-chip-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: linear-gradient(135deg, #5865f2, #eb459e, #f9c835);
            box-shadow: 0 0 6px rgba(114, 137, 218, 0.6);
        }

        #lcu-online-chip b {
            font-weight: 700;
            background: linear-gradient(90deg, #7c92ff, #eb459e, #f9c835);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }
    `;
    document.head.appendChild(styleElement);
}

function createChip(): HTMLDivElement {
    const existing = document.getElementById("lcu-online-chip") as HTMLDivElement | null;
    if (existing) return existing;
    chip = document.createElement("div");
    chip.id = "lcu-online-chip";
    chip.style.display = "none";
    chip.innerHTML =
        '<span class="lcu-chip-dot"></span><span>LegCord online:&nbsp;</span><b id="lcu-online-count">0</b>';
    document.body.appendChild(chip);
    return chip;
}

function updateChip(): void {
    const el = document.getElementById("lcu-online-count");
    if (el) el.textContent = String(online.size);
}

function syncChipVisibility(): void {
    const el = document.getElementById("lcu-online-chip");
    if (!el) return;
    const settingsOpen =
        document.querySelector(SETTINGS_SELECTOR) !== null &&
        document.visibilityState === "visible" &&
        (document.body.innerText || "").length > 0;
    el.style.display = settingsOpen ? "flex" : "none";
}

function startBeacon(): void {
    if (!beaconEnabled) return;
    dispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: {
            type: 0,
            name: MARKER_NAME,
            application_id: Number(MARKER_APP_ID),
            details: "LegCord client",
            timestamps: { start: Date.now() },
        },
    });
}

function scheduleBeacon(): void {
    if (beaconTimer !== null) return;
    beaconTimer = window.setInterval(() => {
        startBeacon();
    }, BEACON_INTERVAL_MS);
}

export function setLegCordBeacon(enabled: boolean): void {
    beaconEnabled = enabled;
    if (enabled) {
        startBeacon();
        scheduleBeacon();
        log("beacon ON — тебя видно как пользователя LegCord");
    } else {
        if (beaconTimer !== null) {
            clearInterval(beaconTimer);
            beaconTimer = null;
        }
        dispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null });
        log("beacon OFF");
    }
}

export function onLoad(): void {
    log("LegCord Users addon loaded");
    injectStyles();
    createChip();
    updateChip();

    const presenceHandler = onPresenceUpdate as never;
    const guildCreateHandler = onGuildCreate as never;
    const guildChunkHandler = onGuildMembersChunk as never;

    dispatcher.subscribe("PRESENCE_UPDATE", presenceHandler);
    dispatcher.subscribe("GUILD_CREATE", guildCreateHandler);
    dispatcher.subscribe("GUILD_MEMBERS_CHUNK", guildChunkHandler);

    observer = new MutationObserver(() => scheduleRescan());
    observer.observe(document.body, { childList: true, subtree: true });

    rescan();
    interval = window.setInterval(rescan, 5000);
    chipTimer = window.setInterval(syncChipVisibility, 1000);

    // Маяк включён по умолчанию: каждый запустивший LegCord виден другим.
    startBeacon();
    scheduleBeacon();

    const global = globalThis as unknown as Record<string, unknown>;
    global.legcordUsersBeacon = setLegCordBeacon;
}

export function onUnload(): void {
    if (beaconTimer !== null) {
        clearInterval(beaconTimer);
        beaconTimer = null;
    }
    if (rescanTimer !== null) {
        clearTimeout(rescanTimer);
        rescanTimer = null;
    }
    if (interval !== null) {
        clearInterval(interval);
        interval = null;
    }
    if (chipTimer !== null) {
        clearInterval(chipTimer);
        chipTimer = null;
    }
    dispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null });
    styleElement?.remove();
    styleElement = null;
    chip?.remove();
    chip = null;
    marked.clear();
    online.clear();
    const global = globalThis as unknown as Record<string, unknown>;
    delete global.legcordUsersBeacon;
}
