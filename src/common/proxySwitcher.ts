import { connect, type Socket } from "node:net";
import { getConfig, setConfig } from "./config.js";
import { applySessionProxy } from "./proxy.js";

interface Candidate {
    url: string;
    host: string;
    port: number;
}

const CHECK_INTERVAL_MS = 12000;
const FULL_SCAN_INTERVAL_MS = 60000;
const LIST_FETCH_TIMEOUT_MS = 6000;
const MEASURE_TIMEOUT_MS = 2000;
const MAX_CANDIDATES = 40;

const log = (message: string): void => console.log(`[ProxySwitcher] ${message}`);
const logError = (message: string): void => console.error(`[ProxySwitcher] ${message}`);

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
                // source unreachable, skip it
            }
        }),
    );
    return found;
}

function measure(proxy: Candidate): Promise<number | null> {
    return new Promise((resolve) => {
        const started = Date.now();
        const socket: Socket = connect({ host: proxy.host, port: proxy.port });
        let settled = false;
        const done = (latency: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(latency);
        };
        const timer = setTimeout(() => done(null), MEASURE_TIMEOUT_MS);
        socket.setTimeout(MEASURE_TIMEOUT_MS);
        socket.on("connect", () => done(Date.now() - started));
        socket.on("timeout", () => done(null));
        socket.on("error", () => done(null));
    });
}

async function measureAll(candidates: Candidate[], limit: number): Promise<Map<string, number>> {
    const latencies = new Map<string, number>();
    const results = await Promise.all(candidates.slice(0, limit).map((candidate) => measure(candidate)));
    candidates.slice(0, limit).forEach((candidate, index) => {
        const latency = results[index];
        if (latency !== null) latencies.set(candidate.url, latency);
    });
    return latencies;
}

function candidatesFromSettings(): { all: Candidate[]; currentUrl: string | null } {
    const custom = splitList(getConfig("proxyCustomList"));
    const currentUrl = parseCurrentRules((getConfig("proxyRules") ?? "").trim());
    const seen = new Set<string>();
    const all: Candidate[] = [];
    const push = (url: string | null) => {
        const normalized = normalizeProxy(url ?? "");
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        const parsed = new URL(normalized);
        all.push({ url: normalized, host: parsed.hostname, port: Number(parsed.port) });
    };
    custom.forEach(push);
    if (currentUrl) seen.add(currentUrl);
    return { all, currentUrl };
}

let stopped = false;
let lastFullScan = 0;

async function cycle(): Promise<void> {
    if (stopped) return;
    if (getConfig("proxyAuto") !== true) {
        log("auto proxy disabled, waiting");
        return;
    }

    const threshold = Math.max(50, Math.min(2000, Number(getConfig("proxyThreshold")) || 100));
    const sourceList = (getConfig("proxySources") ?? "").trim();
    const { all, currentUrl } = candidatesFromSettings();

    const now = Date.now();
    const needsFullScan = currentUrl === null || now - lastFullScan > FULL_SCAN_INTERVAL_MS;
    const currentLatency =
        currentUrl && now - lastFullScan > CHECK_INTERVAL_MS * 2
            ? ((
                  await measureAll(
                      [{ url: currentUrl, host: new URL(currentUrl).hostname, port: Number(new URL(currentUrl).port) }],
                      1,
                  )
              ).get(currentUrl) ?? null)
            : null;

    if (needsFullScan && sourceList) {
        const fromLists = await fetchListSources(sourceList);
        for (const url of fromLists) {
            if (!all.some((candidate) => candidate.url === url)) {
                const parsed = new URL(url);
                all.push({ url, host: parsed.hostname, port: Number(parsed.port) });
            }
        }
    }

    if (all.length === 0 && needsFullScan && sourceList && (getConfig("proxyCustomList") ?? "").trim() === "") {
        logError("no proxies available (check sources)");
        return;
    }

    if (currentUrl && currentLatency !== null && currentLatency <= threshold && !needsFullScan) {
        return;
    }

    const latencies = await measureAll(all, MAX_CANDIDATES);
    if (latencies.size === 0) {
        logError("no proxy is reachable right now");
        return;
    }
    lastFullScan = now;

    let bestUrl: string | null = null;
    let bestLatency = Number.POSITIVE_INFINITY;
    for (const [url, latency] of latencies) {
        if (latency < bestLatency) {
            bestLatency = latency;
            bestUrl = url;
        }
    }

    if (currentUrl && currentLatency !== null && bestUrl === currentUrl) {
        log(`keeping current proxy ${currentUrl} (${currentLatency}ms)`);
        return;
    }
    const worthSwitching =
        currentUrl === null ||
        bestLatency < (currentLatency ?? Number.POSITIVE_INFINITY) - 15 ||
        (currentLatency !== null && currentLatency > threshold);

    if (!bestUrl || !worthSwitching) {
        log(`no better proxy than current (best ${bestLatency}ms)`);
        return;
    }

    log(`switching to ${bestUrl} (${bestLatency}ms)`);
    setConfig("proxyMode", "fixed_servers");
    setConfig("proxyRules", bestUrl);
    if (!(getConfig("proxyBypassRules") ?? "").trim()) setConfig("proxyBypassRules", "<local>");
    await applySessionProxy();
}

let started = false;

/** Start the periodic auto-proxy watcher (idempotent, main process only). */
export function startProxySwitcher(): void {
    if (started) return;
    started = true;
    const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
            await cycle();
        } catch (error) {
            logError(error instanceof Error ? error.message : String(error));
        }
        if (!stopped) setTimeout(() => void tick(), CHECK_INTERVAL_MS);
    };
    setTimeout(() => void tick(), 3000);
}

/** Stop the periodic watcher (called on app quit). */
export function stopProxySwitcher(): void {
    stopped = true;
}
