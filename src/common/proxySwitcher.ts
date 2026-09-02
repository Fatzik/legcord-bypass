import { connect, type Socket } from "node:net";
import { getConfig, setConfig } from "./config.js";
import { applySessionProxy } from "./proxy.js";

interface Candidate {
    url: string;
    host: string;
    port: number;
    tcp: number | null;
    discord: number | null;
}

const FAST_CHECK_MS = 2500;
const FULL_SCAN_MS = 45000;
const LIST_FETCH_TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 1500;
const DISCORD_PROBE_HOST = "discord.com";
const DISCORD_PROBE_PORT = 443;
const MAX_CANDIDATES = 60;

const log = (message: string): void => console.log(`[ProxyWatcher] ${message}`);
const logError = (message: string): void => console.error(`[ProxyWatcher] ${message}`);

function normalizeProxy(line: string): string | null {
    const raw = line.trim();
    if (!raw) return null;
    const withScheme = raw.includes("://") ? raw : `http://${raw}`;
    try {
        const parsed = new URL(withScheme);
        if (!["http:", "https:", "socks4:", "socks5:"].includes(parsed.protocol)) return null;
        if (!parsed.hostname || !parsed.port) return null;
        if (parsed.hostname === "localhost" || parsed.hostname.startsWith("127.")) return null;
        return withScheme;
    } catch {
        return null;
    }
}

function splitList(value: string | undefined): string[] {
    if (!value) return [];
    return value
        .split(/[\r\n,;]+/)
        .map((entry) => normalizeProxy(entry))
        .filter((entry): entry is string => entry !== null);
}

function parseCurrentRules(rules: string): string | null {
    if (!rules) return null;
    const parts = rules
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);
    for (const part of parts) {
        if (!part.includes("=")) return normalizeProxy(part) ?? null;
        const [, value] = part.split("=");
        const first = value?.split(",")[0];
        if (first) return normalizeProxy(first) ?? null;
    }
    return null;
}

async function fetchListSources(sources: string): Promise<string[]> {
    const urls = sources
        .split(/[\r\n,;]+/)
        .map((url) => url.trim())
        .filter(Boolean)
        .filter((url) => /^https?:\/\//i.test(url));
    const found: string[] = [];
    await Promise.all(
        urls.slice(0, 6).map(async (url) => {
            try {
                const response = await fetch(url, { signal: AbortSignal.timeout(LIST_FETCH_TIMEOUT_MS) });
                if (!response.ok) return;
                const text = await response.text();
                for (const line of text.split(/\r?\n/)) {
                    const proxy = normalizeProxy(line);
                    if (proxy && !found.includes(proxy)) found.push(proxy);
                }
            } catch {
                // unreachable source — skip
            }
        }),
    );
    return found;
}

function openSocket(proxy: Candidate): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = connect({ host: proxy.host, port: proxy.port });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("connect timeout"));
        }, CONNECT_TIMEOUT_MS);
        socket.once("connect", () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** TCP round-trip to the proxy itself. */
async function tcpPing(proxy: Candidate): Promise<number | null> {
    const started = Date.now();
    try {
        const socket = await openSocket(proxy);
        socket.destroy();
        return Date.now() - started;
    } catch {
        return null;
    }
}

/** Measure how fast traffic actually reaches Discord THROUGH the proxy (HTTP CONNECT). */
async function discordThroughProxy(proxy: Candidate): Promise<number | null> {
    const started = Date.now();
    let socket: Socket | null = null;
    try {
        socket = await openSocket(proxy);
        if (!["http:", "https:"].includes(proxy.url.split("://")[0] + ":")) {
            socket.destroy();
            return null;
        }
        return await new Promise<number | null>((resolve) => {
            let buffer = "";
            const timer = setTimeout(() => {
                socket?.destroy();
                resolve(null);
            }, CONNECT_TIMEOUT_MS);
            socket!.on("data", (chunk) => {
                buffer += chunk.toString("latin1");
                if (buffer.includes("\r\n\r\n")) {
                    clearTimeout(timer);
                    const ok = /^HTTP\/\S+\s+200/i.test(buffer);
                    socket?.destroy();
                    resolve(ok ? Date.now() - started : null);
                }
            });
            socket!.on("error", () => {
                clearTimeout(timer);
                resolve(null);
            });
            socket!.on("close", () => {
                clearTimeout(timer);
                resolve(null);
            });
            const hostHeader = `${DISCORD_PROBE_HOST}:${DISCORD_PROBE_PORT}`;
            socket!.write(
                `CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
            );
        });
    } catch {
        return null;
    } finally {
        socket?.destroy();
    }
}

function proxyFromUrl(url: string): Candidate {
    const parsed = new URL(url);
    return { url, host: parsed.hostname, port: Number(parsed.port), tcp: null, discord: null };
}

const state = {
    pool: [] as Candidate[],
    poolAge: 0,
    currentUrl: null as string | null,
    consecutiveFailures: 0,
    lastBest: null as string | null,
};

async function refreshPool(): Promise<void> {
    const custom = splitList(getConfig("proxyCustomList"));
    const seen = new Set<string>();
    const raw: string[] = [];
    for (const url of custom) {
        if (!seen.has(url)) {
            seen.add(url);
            raw.push(url);
        }
    }
    const sources = (getConfig("proxySources") ?? "").trim();
    if (sources) {
        const fetched = await fetchListSources(sources);
        for (const url of fetched) {
            if (!seen.has(url) && raw.length < MAX_CANDIDATES) {
                seen.add(url);
                raw.push(url);
            }
        }
    }
    if (state.currentUrl && !seen.has(state.currentUrl)) raw.push(state.currentUrl);

    const pool = raw.slice(0, MAX_CANDIDATES).map(proxyFromUrl);
    const results = await Promise.all(pool.map((candidate) => tcpPing(candidate)));
    pool.forEach((candidate, index) => {
        candidate.tcp = results[index];
    });
    state.pool = pool.filter((candidate) => candidate.tcp !== null);
    state.poolAge = Date.now();

    // Validate the fastest handful against Discord so a "connectable but useless"
    // proxy can never be selected for a switch.
    const fastest = [...state.pool].sort((a, b) => (a.tcp ?? 1e9) - (b.tcp ?? 1e9)).slice(0, 5);
    const validated = await Promise.all(fastest.map((candidate) => discordThroughProxy(candidate)));
    fastest.forEach((candidate, index) => {
        candidate.discord = validated[index];
        if (validated[index] !== null && candidate.tcp === null) candidate.tcp = validated[index];
    });
    log(`pool: ${state.pool.length} live proxies, top validated against Discord`);
}

function chooseBest(currentLatency: number | null): Candidate | null {
    const candidates = state.pool.filter((candidate) => candidate.url !== state.currentUrl);
    const withDiscord = candidates.filter((candidate) => candidate.discord !== null);
    const usable = (withDiscord.length > 0 ? withDiscord : candidates).filter((candidate) => candidate.tcp !== null);
    if (usable.length === 0) return null;
    usable.sort((a, b) => (a.discord ?? a.tcp ?? 1e9) - (b.discord ?? b.tcp ?? 1e9));
    const best = usable[0];
    if (!best) return null;
    const bestLatency = best.discord ?? best.tcp ?? Number.POSITIVE_INFINITY;
    if (currentLatency !== null && bestLatency >= currentLatency - 10) return null;
    return best;
}

async function switchTo(candidate: Candidate): Promise<void> {
    log(`seamless switch → ${candidate.url} (${candidate.discord ?? candidate.tcp}ms)`);
    setConfig("proxyMode", "fixed_servers");
    setConfig("proxyRules", candidate.url);
    if (!(getConfig("proxyBypassRules") ?? "").trim()) setConfig("proxyBypassRules", "<local>");
    state.currentUrl = candidate.url;
    state.consecutiveFailures = 0;
    state.lastBest = candidate.url;
    await applySessionProxy();
}

let stopped = false;
let started = false;

async function cycle(): Promise<void> {
    if (stopped) return;
    if (getConfig("proxyAuto") !== true) {
        state.consecutiveFailures = 0;
        return;
    }

    const threshold = Math.max(50, Math.min(2000, Number(getConfig("proxyThreshold")) || 100));
    const currentFromRules = parseCurrentRules((getConfig("proxyRules") ?? "").trim());
    if (currentFromRules !== state.currentUrl) {
        state.currentUrl = currentFromRules;
        state.consecutiveFailures = 0;
    }

    const now = Date.now();
    if (state.pool.length === 0 || now - state.poolAge > FULL_SCAN_MS) {
        await refreshPool();
    }

    if (state.pool.length === 0) {
        if (state.consecutiveFailures >= 1) {
            logError("proxy pool is empty — Discord will be unreachable until a proxy is configured");
        }
        return;
    }

    let currentLatency: number | null = null;
    if (state.currentUrl) {
        const current = proxyFromUrl(state.currentUrl);
        currentLatency = await tcpPing(current);
        if (currentLatency !== null) {
            const throughDiscord = await discordThroughProxy(current);
            if (throughDiscord !== null) currentLatency = throughDiscord;
        }
    }

    const isDown = currentLatency === null;
    const isTooSlow = currentLatency !== null && currentLatency > threshold;

    if (state.currentUrl && !isDown && !isTooSlow) {
        state.consecutiveFailures = 0;
        return;
    }

    if (state.currentUrl && isDown) {
        state.consecutiveFailures++;
        if (state.consecutiveFailures < 2) {
            log(`proxy looks down (${state.consecutiveFailures}/2), confirming before switching…`);
            return;
        }
        log(`proxy ${state.currentUrl} is down, switching`);
    } else if (isTooSlow) {
        state.consecutiveFailures = 0;
        log(`proxy ${state.currentUrl} is slow (${currentLatency}ms > ${threshold}ms), searching…`);
    } else if (!state.currentUrl) {
        log("no active proxy, picking the best one");
    }

    const best = chooseBest(currentLatency);
    if (best) {
        await switchTo(best);
    } else {
        state.consecutiveFailures = 0;
        log("no better validated proxy available right now; keeping current");
    }
}

/** Start the periodic proxy watcher (idempotent, main process only). */
export function startProxyWatcher(): void {
    if (started) return;
    started = true;
    const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
            await cycle();
        } catch (error) {
            logError(error instanceof Error ? error.message : String(error));
        }
        if (!stopped) setTimeout(() => void tick(), FAST_CHECK_MS);
    };
    setTimeout(() => void tick(), 1500);
}

/** Stop the periodic watcher (called on app quit). */
export function stopProxyWatcher(): void {
    stopped = true;
}
