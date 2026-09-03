/// <reference path="../../../node_modules/@uwu/shelter-defs/dist/shelter-defs/rootdefs.d.ts" />

const {
    util: { log },
    flux: { dispatcher },
} = shelter;

/**
 * Опознавательный маркер LegCord.
 *
 * Что считать «своим»:
 *  - активность с нашим application_id;
 *  - активность с именем/деталями, содержащими "legcord".
 *
 * Чтобы тебя видели другие LegCord-клиенты, включи маяк:
 *   window.legcordUsersBeacon(true)
 * и выключи, когда не нужен:
 *   window.legcordUsersBeacon(false)
 */
const MARKER_NAME = "LegCord";
const MARKER_APP_ID = "1294003123519467661";

const USERNAME_SELECTOR = '[id^="message-username-"]';

const marked = new Set<string>();

const listeners: Array<() => void> = [];
let styleElement: HTMLStyleElement | null = null;
let observer: MutationObserver | null = null;
let rescanTimer: number | null = null;
let interval: number | null = null;
let tooltip: HTMLDivElement | null = null;

function isLegCordActivity(
    activity:
        | { type?: number; application_id?: string | number; name?: string; details?: string; state?: string }
        | null
        | undefined,
): boolean {
    if (!activity || typeof activity !== "object") return false;
    const appId = String(activity.application_id ?? "");
    if (appId !== "" && appId === MARKER_APP_ID) return true;
    const haystack = [activity.name, activity.details, activity.state]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
    return haystack.includes("legcord");
}

function hasLegCordActivity(activities: unknown): boolean {
    return Array.isArray(activities) && activities.some((activity) => isLegCordActivity(activity as never));
}

function setMarked(userId: string, isLegCord: boolean): void {
    const id = String(userId);
    if (isLegCord) {
        if (marked.has(id)) return;
        marked.add(id);
    } else {
        if (!marked.delete(id)) return;
    }
    scheduleRescan();
}

function applyPresence(presence: { user?: { id?: string }; activities?: unknown } | undefined): void {
    if (!presence?.user?.id) return;
    setMarked(presence.user.id, hasLegCordActivity(presence.activities));
}

function onPresenceUpdate(payload: { user?: { id?: string }; activities?: unknown }): void {
    applyPresence(payload);
}

function onGuildCreate(payload: { presences?: Array<{ user?: { id?: string }; activities?: unknown }> }): void {
    for (const presence of payload.presences ?? []) applyPresence(presence);
}

function onGuildMembersChunk(payload: { presences?: Array<{ user?: { id?: string }; activities?: unknown }> }): void {
    for (const presence of payload.presences ?? []) applyPresence(presence);
}

function userIdFromElement(element: Element): string | null {
    const id = element.getAttribute("id") ?? "";
    const prefix = "message-username-";
    if (!id.startsWith(prefix)) return null;
    const userId = id.slice(prefix.length);
    return userId.length > 0 && /^\d+$/.test(userId) ? userId : null;
}

function applyMarkToElement(element: Element): void {
    const userId = userIdFromElement(element);
    if (userId === null) return;
    if (marked.has(userId)) {
        element.classList.add("lcu-legcord");
        element.setAttribute("data-lcu-user", userId);
    } else {
        element.classList.remove("lcu-legcord");
        element.removeAttribute("data-lcu-user");
    }
}

function rescanUsernames(): void {
    for (const element of document.querySelectorAll(USERNAME_SELECTOR)) applyMarkToElement(element);
}

function scheduleRescan(): void {
    if (rescanTimer !== null) return;
    rescanTimer = window.setTimeout(() => {
        rescanTimer = null;
        rescanUsernames();
    }, 250);
}

function hideTooltip(): void {
    tooltip?.remove();
    tooltip = null;
}

function showTooltip(target: Element): void {
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    hideTooltip();
    tooltip = document.createElement("div");
    tooltip.className = "lcu-tooltip";
    tooltip.innerHTML =
        '<span class="lcu-tooltip-mark">●</span><span class="lcu-tooltip-text">Пользователь использует тот же клиент, что и вы — <b>LegCord</b>.</span>';
    document.body.appendChild(tooltip);
    const tooltipRect = tooltip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    let top = rect.bottom + 8;
    if (left < 8) left = 8;
    if (left + tooltipRect.width > window.innerWidth - 8) left = window.innerWidth - tooltipRect.width - 8;
    if (top + tooltipRect.height > window.innerHeight - 8) top = rect.top - tooltipRect.height - 8;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
}

function isLegCordElement(element: Element | null): boolean {
    return element?.classList.contains("lcu-legcord") === true;
}

function onPointerOver(event: PointerEvent): void {
    const target = event.target as Element | null;
    const username = target?.closest?.(USERNAME_SELECTOR) ?? null;
    if (username && isLegCordElement(username)) showTooltip(username);
}

function onPointerOut(event: PointerEvent): void {
    const target = event.target as Element | null;
    const username = target?.closest?.(USERNAME_SELECTOR) ?? null;
    if (!username || !isLegCordElement(username)) return;
    const related = event.relatedTarget as Element | null;
    if (related && username.contains(related)) return;
    hideTooltip();
}

function injectStyles(): void {
    if (styleElement) return;
    styleElement = document.createElement("style");
    styleElement.textContent = `
        .lcu-legcord {
            position: relative;
            cursor: help;
            border-radius: 3px;
            transition: filter 0.2s ease;
        }

        .lcu-legcord::after {
            content: "";
            display: inline-block;
            width: 7px;
            height: 7px;
            margin-left: 5px;
            border-radius: 50%;
            vertical-align: middle;
            background: linear-gradient(135deg, #5865f2, #eb459e, #f9c835, #5865f2);
            background-size: 300% 300%;
            box-shadow: 0 0 6px rgba(235, 69, 158, 0.55);
        }

        .lcu-legcord:hover {
            background-image: linear-gradient(90deg, #5865f2, #eb459e, #f9c835, #5865f2);
            background-size: 200% auto;
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            filter: drop-shadow(0 0 6px rgba(139, 100, 255, 0.65));
        }

        .lcu-tooltip {
            position: fixed;
            z-index: 2147483000;
            display: flex;
            align-items: center;
            gap: 7px;
            max-width: 320px;
            padding: 7px 11px;
            border-radius: 8px;
            background: #1e1f22;
            border: 1px solid transparent;
            background-image: linear-gradient(#1e1f22, #1e1f22), linear-gradient(90deg, #5865f2, #eb459e, #f9c835, #5865f2);
            background-origin: border-box;
            background-clip: padding-box, border-box;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45), 0 0 14px rgba(139, 100, 255, 0.28);
            font-family: "Segoe UI", "Whitney", sans-serif;
            font-size: 13px;
            line-height: 1.25;
            color: #dcddde;
            pointer-events: none;
        }

        .lcu-tooltip-mark {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: linear-gradient(135deg, #5865f2, #eb459e, #f9c835);
            box-shadow: 0 0 6px rgba(235, 69, 158, 0.6);
            font-size: 0;
        }

        .lcu-tooltip-text {
            background-image: linear-gradient(90deg, #ffffff, #e0e0ff);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .lcu-tooltip-text b {
            background-image: linear-gradient(90deg, #7c92ff, #eb459e, #f9c835);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            font-weight: 700;
        }
    `;
    document.head.appendChild(styleElement);
}

export function setLegCordBeacon(enabled: boolean): void {
    dispatcher.dispatch({
        type: "LOCAL_ACTIVITY_UPDATE",
        activity: enabled
            ? {
                  type: 0,
                  name: MARKER_NAME,
                  application_id: Number(MARKER_APP_ID),
                  details: "LegCord client",
                  timestamps: { start: Date.now() },
              }
            : null,
    });
    log(enabled ? "beacon ON — теперь тебя видно как пользователя LegCord" : "beacon OFF");
}

export function onLoad(): void {
    log("LegCord Users addon loaded");
    injectStyles();

    const presenceHandler = onPresenceUpdate as never;
    const guildCreateHandler = onGuildCreate as never;
    const guildChunkHandler = onGuildMembersChunk as never;

    dispatcher.subscribe("PRESENCE_UPDATE", presenceHandler);
    dispatcher.subscribe("GUILD_CREATE", guildCreateHandler);
    dispatcher.subscribe("GUILD_MEMBERS_CHUNK", guildChunkHandler);
    listeners.push(() => {
        dispatcher.unsubscribe("PRESENCE_UPDATE", presenceHandler);
        dispatcher.unsubscribe("GUILD_CREATE", guildCreateHandler);
        dispatcher.unsubscribe("GUILD_MEMBERS_CHUNK", guildChunkHandler);
    });

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    listeners.push(() => {
        document.removeEventListener("pointerover", onPointerOver, true);
        document.removeEventListener("pointerout", onPointerOut, true);
        hideTooltip();
    });

    observer = new MutationObserver(() => scheduleRescan());
    observer.observe(document.body, { childList: true, subtree: true });
    listeners.push(() => observer?.disconnect());

    rescanUsernames();
    interval = window.setInterval(rescanUsernames, 5000);

    const global = globalThis as unknown as Record<string, unknown>;
    global.legcordUsersBeacon = setLegCordBeacon;
    listeners.push(() => {
        delete global.legcordUsersBeacon;
    });
}

export function onUnload(): void {
    for (const cleanup of listeners.splice(0)) {
        try {
            cleanup();
        } catch {
            // ignore cleanup errors
        }
    }
    if (rescanTimer !== null) {
        clearTimeout(rescanTimer);
        rescanTimer = null;
    }
    if (interval !== null) {
        clearInterval(interval);
        interval = null;
    }
    styleElement?.remove();
    styleElement = null;
    marked.clear();
}
