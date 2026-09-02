import { request } from "node:https";
import { connect, type Socket } from "node:net";
import { getConfig, setConfig } from "./config.js";
import { applySessionProxy } from "./proxy.js";

interface Candidate {
    url: string;
    host: string;
    port: number;
    scheme: "http" | "https" | "socks4" | "socks5";
    tcp: number | null;
}

const FAST_CHECK_MS = 2500;
const FULL_SCAN_MS = 45000;
const LIST_FETCH_TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 1500;
const DISCORD_PROBE_HOST = "discord.com";
const DISCORD_PROBE_PORT = 443;
const MAX_CANDIDATES = 60;

const DEFAULT_PROXY_LISTS = [
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all",
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all",
    "https://www.proxy-list.download/api/v1/get?type=http",
    "https://www.proxy-list.download/api/v1/get?type=socks5",
];

const log = (message: string): void => console.log(`[ProxyWatcher] ${message}`);
const logError = (message: string): void => console.error(`[ProxyWatcher] ${message}`);

const autoEnabled = (): boolean => getConfig("proxyAuto") !== false;
const thresholdMs = (): number => Math.max(50, Math.min(2000, Number(getConfig("proxyThreshold")) || 100));

function normalizeProxy(line: string): string | null {
    const raw = line.trim();
    if (!raw) return null;
    const withScheme = raw.includes("://") ? raw : `http://${raw}`;
    try {
        const parsed = new URL(withScheme);
        const scheme = parsed.protocol.slice(0, -1);
        if (!["http", "https", "socks4", "socks5"].includes(scheme)) return null;
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

function proxyFromUrl(url: string): Candidate {
    const parsed = new URL(url);
    return {
        url,
        host: parsed.hostname,
        port: Number(parsed.port),
        scheme: parsed.protocol.slice(0, -1) as Candidate["scheme"],
        tcp: null,
    };
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

/** Real latency through the proxy to Discord (HTTP CONNECT). Socks ≈ tcp ping. */
async function discordThroughProxy(proxy: Candidate): Promise<number | null> {
    if (proxy.scheme !== "http" && proxy.scheme !== "https") {
        return proxy.tcp;
    }
    const started = Date.now();
    let socket: Socket | null = null;
    try {
        socket = await openSocket(proxy);
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

async function fetchListSources(): Promise<string[]> {
    const configured = (getConfig("proxySources") ?? "").trim();
    const sourceRaw = configured ? configured : DEFAULT_PROXY_LISTS.join("\n");
    const urls = sourceRaw
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
                const defaultScheme = /socks5/i.test(url) ? "socks5" : "http";
                for (const line of text.split(/\r?\n/)) {
                    const rawLine = line.includes("://") ? line : `${defaultScheme}://${line}`;
                    const proxy = normalizeProxy(rawLine);
                    if (proxy && !found.includes(proxy)) found.push(proxy);
                }
            } catch {
                // unreachable source — skip
            }
        }),
    );
    return found;
}

function directDiscordReachable(): Promise<boolean> {
    return new Promise((resolve) => {
        const req = request(
            "https://discord.com/api/v9/gateway",
            { method: "GET", headers: { "user-agent": "legcord-bypass/1.0" } },
            (res) => {
                res.resume();
                resolve(true);
            },
        );
        req.setTimeout(2500, () => {
            req.destroy();
            resolve(false);
        });
        req.on("error", () => resolve(false));
        req.end();
    });
}

const state = {
    pool: [] as Candidate[],
    poolAge: 0,
    currentUrl: null as string | null,
    consecutiveFailures: 0,
};

async function buildPool(force = false): Promise<void> {
    const now = Date.now();
    if (!force) {
        if (state.pool.length > 0 && now - state.poolAge < FULL_SCAN_MS) return;
        if (state.pool.length === 0 && now - state.poolAge < FULL_SCAN_MS) return;
    }

    const custom = splitList(getConfig("proxyCustomList"));
    const seen = new Set<string>();
    const raw: string[] = [];
    for (const url of custom) {
        if (!seen.has(url)) {
            seen.add(url);
            raw.push(url);
        }
    }
    const fetched = await fetchListSources();
    for (const url of fetched) {
        if (!seen.has(url) && raw.length < MAX_CANDIDATES) {
            seen.add(url);
            raw.push(url);
        }
    }
    if (state.currentUrl && !seen.has(state.currentUrl)) raw.push(state.currentUrl);

    const pool = raw.slice(0, MAX_CANDIDATES).map(proxyFromUrl);
    const results = await Promise.all(pool.map((candidate) => tcpPing(candidate)));
    pool.forEach((candidate, index) => {
        candidate.tcp = results[index];
    });
    state.pool = pool.filter((candidate) => candidate.tcp !== null).sort((a, b) => (a.tcp ?? 1e9) - (b.tcp ?? 1e9));
    state.poolAge = now;
    log(`pool ready: ${state.pool.length} reachable proxies`);
}

/** Find a proxy that actually reaches Discord; returns its latency. */
async function findWorkingProxy(excludeUrl: string | null): Promise<{ candidate: Candidate; ms: number } | null> {
    const pool = state.pool.filter((candidate) => candidate.url !== excludeUrl);
    for (let start = 0; start < pool.length && start < 25; start += 5) {
        const batch = pool.slice(start, start + 5);
        const results = await Promise.all(batch.map((candidate) => discordThroughProxy(candidate)));
        const hits = batch
            .map((candidate, index) => ({ candidate, ms: results[index] }))
            .filter((hit): hit is { candidate: Candidate; ms: number } => hit.ms !== null);
        if (hits.length > 0) {
            hits.sort((a, b) => a.ms - b.ms);
            const best = hits[0];
            return best ?? null;
        }
    }
    return null;
}

async function applyProxy(candidate: Candidate): Promise<void> {
    log(`applying proxy ${candidate.url}`);
    setConfig("proxyMode", "fixed_servers");
    setConfig("proxyRules", candidate.url);
    if (!(getConfig("proxyBypassRules") ?? "").trim()) setConfig("proxyBypassRules", "<local>");
    state.currentUrl = candidate.url;
    state.consecutiveFailures = 0;
    await applySessionProxy();
}

/**
 * Startup gate: return before the Discord window is created.
 * - Discord reachable directly → nothing to do.
 * - Auto-proxy enabled → guarantee a validated proxy is active first.
 */
export async function prepareInitialProxy(): Promise<"direct" | "proxy" | "none"> {
    if (getConfig("proxyAuto") === false) return "none";
    if (state.currentUrl && (await discordThroughProxy(proxyFromUrl(state.currentUrl))) !== null) {
        return "proxy";
    }
    if (await directDiscordReachable()) {
        log("Discord reachable directly — no proxy needed");
        return "direct";
    }
    log("Discord is blocked; searching for a working proxy…");
    try {
        await buildPool(true);
        const current = parseCurrentRules((getConfig("proxyRules") ?? "").trim());
        if (current && (await discordThroughProxy(proxyFromUrl(current))) !== null) {
            state.currentUrl = current;
            state.consecutiveFailures = 0;
            log(`reusing configured proxy ${current}`);
            return "proxy";
        }
        const found = await findWorkingProxy(null);
        if (found) {
            await applyProxy(found.candidate);
            return "proxy";
        }
        logError("no working proxy found; Discord may fail to load");
        return "none";
    } catch (error) {
        logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
        return "none";
    }
}

async function cycle(): Promise<void> {
    if (stopped) return;
    if (!autoEnabled()) {
        state.consecutiveFailures = 0;
        return;
    }
    const threshold = thresholdMs();
    const currentFromRules = parseCurrentRules((getConfig("proxyRules") ?? "").trim());
    if (currentFromRules !== state.currentUrl) {
        state.currentUrl = currentFromRules;
        state.consecutiveFailures = 0;
    }

    await buildPool(false);

    if (state.pool.length === 0) {
        return;
    }

    let currentLatency: number | null = null;
    if (state.currentUrl) {
        currentLatency = await discordThroughProxy(proxyFromUrl(state.currentUrl));
    }

    const isDown = currentLatency === null;
    const isTooSlow = currentLatency !== null && currentLatency > threshold;

    if (state.currentUrl && !isDown && !isTooSlow) {
        state.consecutiveFailures = 0;
        return;
    }

    if (isDown && state.currentUrl) {
        state.consecutiveFailures++;
        if (state.consecutiveFailures < 2) {
            log(`proxy ${state.currentUrl} unreachable (${state.consecutiveFailures}/2), re-checking…`);
            return;
        }
        log(`proxy ${state.currentUrl} is down, switching…`);
    } else if (isTooSlow) {
        state.consecutiveFailures = 0;
        log(`proxy too slow (${currentLatency}ms > ${threshold}ms), switching…`);
    } else if (!state.currentUrl) {
        log("no active proxy, picking the best one");
    }

    const found = await findWorkingProxy(state.currentUrl);
    if (found) {
        await applyProxy(found.candidate);
    } else {
        state.consecutiveFailures = 0;
        logError("no working replacement proxy found; keeping current");
    }
}

let stopped = false;
let started = false;

/** Start the periodic proxy watcher (idempotent, main process only). */
export function startProxyWatcher(): void {
    if (started) return;
    started = true;
    const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
            await cycle();
        } catch (error) {
            logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
        }
        if (!stopped) setTimeout(() => void tick(), FAST_CHECK_MS);
    };
    setTimeout(() => void tick(), 1500);
}

/** Stop the periodic watcher (called on app quit). */
export function stopProxyWatcher(): void {
    stopped = true;
}
