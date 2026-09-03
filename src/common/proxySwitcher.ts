import { request } from "node:https";
import { connect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { getConfig, setConfig } from "./config.js";
import { applySessionProxy, configureNodeProxyEnv } from "./proxy.js";

interface Candidate {
    url: string;
    host: string;
    port: number;
    scheme: "http" | "https" | "socks4" | "socks5";
    tcp: number | null;
}

const FAST_CHECK_MS = 2500;
const FULL_SCAN_MS = 45000;
const LIST_FETCH_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 1200;
const STARTUP_BUDGET_MS = 14000;
const DISCORD_PROBE_HOST = "discord.com";
const DISCORD_PROBE_PORT = 443;
const MAX_CANDIDATES = 60;
const MAX_RESPONSE_BYTES = 64 * 1024;

const DEFAULT_PROXY_LISTS = [
    // --- GitHub raw (latest) ---
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt",
    "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt",
    "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt",
    "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
    // --- Same lists via mirrors (when direct raw GitHub is blocked) ---
    "https://ghfast.top/https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://ghfast.top/https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "https://gh-proxy.com/https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/https.txt",
    "https://ghfast.top/https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://ghfast.top/https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt",
    // --- Non-GitHub (always reachable when internet is up) ---
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all",
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks4&timeout=10000&country=all",
    "https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all",
    "https://api.proxyscrape.com/v3/?request=displayproxies&protocol=http&timeout=10000&country=all",
    "https://www.proxy-list.download/api/v1/get?type=http",
    "https://www.proxy-list.download/api/v1/get?type=socks4",
    "https://www.proxy-list.download/api/v1/get?type=socks5",
    "https://proxylist.geonode.com/api/proxy-list?limit=300&page=1&sort_by=lastChecked&sort_type=desc&protocols=http",
    "https://proxylist.geonode.com/api/proxy-list?limit=300&page=1&sort_by=lastChecked&sort_type=desc&protocols=socks5",
    "https://www.proxy-list.download/api/v2/get?l=en&t=http",
    "https://openproxylist.xyz/http.txt",
    "https://openproxylist.xyz/socks5.txt",
];

const log = (message: string): void => console.log(`[ProxyWatcher] ${message}`);
const logError = (message: string): void => console.error(`[ProxyWatcher] ${message}`);

const phaseListeners = new Set<(text: string) => void>();
let lastPhaseText = "";
/** Subscribe to human-readable proxy phases (shown on the splash). */
export function onProxyPhase(cb: (text: string) => void): () => void {
    phaseListeners.add(cb);
    if (lastPhaseText) cb(lastPhaseText);
    return () => phaseListeners.delete(cb);
}
function phase(text: string): void {
    if (text === lastPhaseText) return;
    lastPhaseText = text;
    log(text);
    for (const listener of phaseListeners) listener(text);
}

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
        if (!parsed.hostname || !parsed.port || parsed.username || parsed.password) return null;
        const port = Number(parsed.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
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
        const timeout =
            startupDeadline > 0
                ? Math.min(CONNECT_TIMEOUT_MS, Math.max(1, startupDeadline - Date.now()))
                : CONNECT_TIMEOUT_MS;
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("connect timeout"));
        }, timeout);
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

/**
 * "Perfect" end-to-end validation: CONNECT tunnel + TLS handshake + HTTP GET to
 * Discord's gateway API. Only proxies that complete the FULL round-trip are
 * considered valid — this eliminates "CONNECT ok but Discord blocked" cases.
 * SOCKS proxies are validated with a real handshake before the Discord probe.
 */
async function discordThroughProxy(proxy: Candidate): Promise<number | null> {
    const started = Date.now();
    let socket: Socket | null = null;
    let tlsSocket: TLSSocket | null = null;
    try {
        socket = await openSocket(proxy);
        return await new Promise<number | null>((resolve) => {
            let connectBuf = "";
            let httpBuf = "";
            let settled = false;
            const fail = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket?.destroy();
                tlsSocket?.destroy();
                resolve(null);
            };
            const succeed = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                tlsSocket?.destroy();
                socket?.destroy();
                resolve(Date.now() - started);
            };
            const probeTimeout =
                startupDeadline > 0
                    ? Math.min(CONNECT_TIMEOUT_MS * 3, Math.max(1, startupDeadline - Date.now()))
                    : CONNECT_TIMEOUT_MS * 3;
            const timer = setTimeout(fail, probeTimeout);
            const sendDiscordRequest = (transport: Socket | TLSSocket, alreadyTls = false): void => {
                const requestText = `GET /api/v9/gateway HTTP/1.1\r\nHost: ${DISCORD_PROBE_HOST}\r\nConnection: close\r\nUser-Agent: legcord-bypass/1.0\r\n\r\n`;
                tlsSocket = alreadyTls
                    ? (transport as TLSSocket)
                    : tlsConnect(
                          { socket: transport, servername: DISCORD_PROBE_HOST, rejectUnauthorized: true },
                          () => {
                              transport.removeAllListeners("data");
                              tlsSocket?.write(requestText);
                          },
                      );
                const secureSocket = tlsSocket;
                if (!secureSocket) {
                    fail();
                    return;
                }
                if (alreadyTls) secureSocket.write(requestText);
                secureSocket.on("error", fail);
                secureSocket.on("data", (chunk: Buffer) => {
                    if (httpBuf.length + chunk.length > MAX_RESPONSE_BYTES) {
                        fail();
                        return;
                    }
                    httpBuf += chunk.toString("latin1");
                    if (!httpBuf.includes("\r\n\r\n")) return;
                    if (!/^HTTP\/\S+\s+2\d\d/i.test(httpBuf)) {
                        fail();
                        return;
                    }
                    if (/"url"\s*:\s*"wss:\/\//.test(httpBuf)) succeed();
                });
            };
            const onConnectData = (chunk: Buffer): void => {
                connectBuf += chunk.toString("latin1");
                if (connectBuf.length > MAX_RESPONSE_BYTES) {
                    fail();
                    return;
                }
                if (!connectBuf.includes("\r\n\r\n")) return;
                if (!/^HTTP\/\S+\s+200/i.test(connectBuf)) {
                    fail();
                    return;
                }
                const transport = proxy.scheme === "https" ? tlsSocket! : socket!;
                transport.removeListener("data", onConnectData);
                // An HTTPS proxy has an outer TLS session to the proxy. Discord
                // still needs its own inner TLS session through the CONNECT tunnel.
                sendDiscordRequest(proxy.scheme === "https" ? tlsSocket! : socket!);
            };
            socket!.on("error", fail);
            if (proxy.scheme === "socks4" || proxy.scheme === "socks5") {
                let handshakeBuffer = Buffer.alloc(0);
                const read = (length: number): Promise<Buffer> =>
                    new Promise((resolveRead, rejectRead) => {
                        const onData = (chunk: Buffer) => {
                            handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
                            if (handshakeBuffer.length >= length) {
                                socket!.removeListener("data", onData);
                                const result = handshakeBuffer.subarray(0, length);
                                handshakeBuffer = handshakeBuffer.subarray(length);
                                resolveRead(result);
                            }
                        };
                        socket!.once("error", rejectRead);
                        if (handshakeBuffer.length >= length) {
                            socket!.removeListener("data", onData);
                            const result = handshakeBuffer.subarray(0, length);
                            handshakeBuffer = handshakeBuffer.subarray(length);
                            resolveRead(result);
                            return;
                        }
                        socket!.on("data", onData);
                    });
                const handshake = async (): Promise<void> => {
                    if (proxy.scheme === "socks5") {
                        socket!.write(Buffer.from([5, 1, 0]));
                        const greeting = await read(2);
                        if (greeting[0] !== 5 || greeting[1] !== 0) throw new Error("SOCKS5 auth rejected");
                        const host = Buffer.from(DISCORD_PROBE_HOST, "ascii");
                        socket!.write(
                            Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([1, 187])]),
                        );
                        const reply = await read(4);
                        if (reply[0] !== 5 || reply[1] !== 0) throw new Error("SOCKS5 connect rejected");
                        const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await read(1))[0];
                        await read(addressLength + 2);
                    } else {
                        const host = Buffer.from(DISCORD_PROBE_HOST, "ascii");
                        socket!.write(
                            Buffer.concat([Buffer.from([4, 1, 1, 187, 0, 0, 0, 1, 0]), host, Buffer.from([0])]),
                        );
                        const reply = await read(8);
                        if (reply[1] !== 90) throw new Error("SOCKS4 connect rejected");
                    }
                    sendDiscordRequest(socket!);
                };
                void handshake().catch(fail);
                return;
            }
            socket!.on("data", onConnectData);
            const hostHeader = `${DISCORD_PROBE_HOST}:${DISCORD_PROBE_PORT}`;
            if (proxy.scheme === "http") {
                socket!.write(
                    `CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
                );
            } else {
                socket!.removeListener("data", onConnectData);
                tlsSocket = tlsConnect({ socket: socket!, servername: proxy.host, rejectUnauthorized: true }, () => {
                    tlsSocket!.on("data", onConnectData);
                    tlsSocket!.write(
                        `CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\nProxy-Connection: Keep-Alive\r\n\r\n`,
                    );
                });
                tlsSocket.on("error", fail);
            }
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

    const pushProxy = (rawLine: string): void => {
        const proxy = normalizeProxy(rawLine);
        if (proxy && !found.includes(proxy) && found.length < MAX_CANDIDATES) found.push(proxy);
    };

    for (let start = 0; start < urls.length && found.length < MAX_CANDIDATES; start += 6) {
        await Promise.all(
            urls.slice(start, start + 6).map(async (url) => {
                try {
                    const timeout =
                        startupDeadline > 0
                            ? Math.min(LIST_FETCH_TIMEOUT_MS, Math.max(1, startupDeadline - Date.now()))
                            : LIST_FETCH_TIMEOUT_MS;
                    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
                    if (!response.ok) return;
                    const text = await response.text();
                    const trimmed = text.trim();

                    // JSON sources (e.g. geonode): { "data": [ { "protocols": [...], "ip": ..., "port": ... } ] }
                    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                        try {
                            const json = JSON.parse(trimmed);
                            const items = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
                            for (const item of items) {
                                const protocols: string[] = Array.isArray(item?.protocols) ? item.protocols : [];
                                const ip: string = item?.ip ?? item?.ipAddress ?? "";
                                const port: number | string = item?.port ?? "";
                                if (!ip || !port) continue;
                                const scheme = protocols.includes("socks5")
                                    ? "socks5"
                                    : protocols.includes("socks4")
                                      ? "socks4"
                                      : protocols.includes("http")
                                        ? "http"
                                        : "http";
                                pushProxy(`${scheme}://${ip}:${port}`);
                            }
                            return;
                        } catch {
                            // not actually JSON — fall through to line parsing
                        }
                    }

                    const defaultScheme = /socks5/i.test(url) ? "socks5" : /socks4/i.test(url) ? "socks4" : "http";
                    for (const line of text.split(/\r?\n/)) {
                        const clean = line.trim();
                        if (!clean) continue;
                        const rawLine = clean.includes("://") ? clean : `${defaultScheme}://${clean}`;
                        pushProxy(rawLine);
                    }
                } catch {
                    // unreachable source — skip
                }
            }),
        );
    }
    return found;
}

function directDiscordReachable(): Promise<boolean> {
    return new Promise((resolve) => {
        let body = "";
        const req = request(
            "https://discord.com/api/v9/gateway",
            { method: "GET", headers: { "user-agent": "legcord-bypass/1.0" } },
            (res) => {
                res.setEncoding("utf8");
                res.on("data", (chunk: string) => {
                    body += chunk;
                    if (body.length > MAX_RESPONSE_BYTES) req.destroy();
                });
                res.on("end", () => {
                    resolve(
                        res.statusCode !== undefined &&
                            res.statusCode >= 200 &&
                            res.statusCode < 300 &&
                            /"url"\s*:\s*"wss:\/\//.test(body),
                    );
                });
            },
        );
        req.setTimeout(1500, () => {
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
    buildPromise: null as Promise<void> | null,
    switchPromise: null as Promise<boolean> | null,
};

let startupDeadline = 0;
const withinStartupDeadline = (): boolean => startupDeadline === 0 || Date.now() < startupDeadline;

async function buildPool(force = false): Promise<void> {
    if (state.buildPromise) return state.buildPromise;
    state.buildPromise = buildPoolInternal(force);
    try {
        await state.buildPromise;
    } finally {
        state.buildPromise = null;
    }
}

async function buildPoolInternal(force = false): Promise<void> {
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
    phase(`Проверяем ${state.pool.length} прокси…`);
}

/** Scan a candidate list in small batches and return the GLOBAL best hit. */
async function scanPool(
    pool: Candidate[],
    excludeUrl: string | null,
    maxProbes: number,
): Promise<{ candidate: Candidate; ms: number } | null> {
    const list = pool.filter((candidate) => candidate.url !== excludeUrl);
    let best: { candidate: Candidate; ms: number } | null = null;
    for (let start = 0; start < list.length && start < maxProbes; start += 5) {
        if (!withinStartupDeadline()) return best;
        const batch = list.slice(start, start + 5);
        phase(`Проверяем прокси ${start + 1}–${Math.min(start + batch.length, list.length)}…`);
        const results = await Promise.all(batch.map((candidate) => discordThroughProxy(candidate)));
        for (let index = 0; index < batch.length; index++) {
            const candidate = batch[index];
            const ms = results[index];
            if (candidate && ms !== null && (best === null || ms < best.ms)) {
                best = { candidate, ms };
            }
            if (candidate) {
                phase(
                    ms === null
                        ? `Прокси ${candidate.host}:${candidate.port} не работает`
                        : `Прокси ${candidate.host}:${candidate.port} работает (${ms} мс)`,
                );
            }
        }
        if (best && start + 5 >= 10) {
            // A solid hit already found — stop scanning further candidates.
            break;
        }
    }
    return best;
}

/** Find a proxy that actually reaches Discord. HTTP(S) proxies are CONNECT-verified first. */
async function findWorkingProxy(excludeUrl: string | null): Promise<{ candidate: Candidate; ms: number } | null> {
    const httpPool = state.pool.filter((candidate) => candidate.scheme === "http" || candidate.scheme === "https");
    const verified = await scanPool(httpPool, excludeUrl, 15);
    if (verified) return verified;
    const socksPool = state.pool.filter((candidate) => candidate.scheme === "socks4" || candidate.scheme === "socks5");
    return scanPool(socksPool, excludeUrl, 10);
}

async function applyProxy(candidate: Candidate): Promise<void> {
    log(`applying proxy ${candidate.url}`);
    phase(`Подключаемся через ${candidate.url}…`);
    setConfig("proxyMode", "fixed_servers");
    setConfig("proxyRules", candidate.url);
    if (!(getConfig("proxyBypassRules") ?? "").trim()) setConfig("proxyBypassRules", "<local>");
    state.currentUrl = candidate.url;
    state.consecutiveFailures = 0;
    // Hidden switch: do NOT close existing connections — Chromium routes new
    // requests through the new proxy while open sockets drain, so Discord never
    // shows a "no internet"/grey page during the swap.
    configureNodeProxyEnv();
    await applySessionProxy(false);
    phase(`Прокси работает: ${candidate.host}:${candidate.port} (${candidate.scheme})`);
}

/** Immediate switch to a different validated proxy (e.g. voice got stuck). */
export async function forceProxySwitch(reason: string): Promise<boolean> {
    if (!autoEnabled()) return false;
    if (state.switchPromise) return state.switchPromise;
    state.switchPromise = forceProxySwitchInternal(reason);
    try {
        return await state.switchPromise;
    } finally {
        state.switchPromise = null;
    }
}

async function forceProxySwitchInternal(reason: string): Promise<boolean> {
    log(`forced proxy switch requested: ${reason}`);
    try {
        await buildPool(true);
        if (state.pool.length === 0) {
            phase("Нет доступных прокси для переключения");
            return false;
        }
        const found = await findWorkingProxy(state.currentUrl);
        if (found) {
            await applyProxy(found.candidate);
            log(`forced switch done (${reason}) → ${found.candidate.url} (${found.ms}ms)`);
            return true;
        }
        phase("Рабочая замена прокси не найдена");
        logError(`forced switch failed (${reason}): no replacement proxy found`);
        return false;
    } catch (error) {
        logError(error instanceof Error ? error.message : String(error));
        return false;
    }
}

export interface ProxyAcceptResult {
    ok: boolean;
    url: string;
    ms: number;
    error?: string;
}

/**
 * Ping a user-provided proxy (supports http://…, socks5://… and bare host:port)
 * and, if it really works, apply it as the current proxy.
 */
export async function acceptCustomProxy(raw: string): Promise<ProxyAcceptResult> {
    const normalized = normalizeProxy(raw);
    if (!normalized) {
        return { ok: false, url: "", ms: 0, error: "Некорректный формат: нужно host:port, http://… или socks5://…" };
    }
    const candidate = proxyFromUrl(normalized);
    const ms = await discordThroughProxy(candidate);
    if (ms === null) {
        return { ok: false, url: normalized, ms: 0, error: "Прокси не отвечает — пинг не прошёл" };
    }
    await applyProxy(candidate);
    log(`custom proxy accepted: ${normalized} (${ms}ms)`);
    return { ok: true, url: normalized, ms };
}

/**
 * Startup gate: return before the Discord window is created.
 * - Discord reachable directly → nothing to do.
 * - Auto-proxy enabled → guarantee a validated proxy is active first.
 */
export async function prepareInitialProxy(): Promise<"direct" | "proxy" | "none"> {
    const startedAt = Date.now();
    startupDeadline = startedAt + STARTUP_BUDGET_MS;
    try {
        if (getConfig("proxyAuto") === false) return "none";
        const cached = state.currentUrl ? proxyFromUrl(state.currentUrl) : null;
        const canTrustCached = cached && (cached.scheme === "http" || cached.scheme === "https");
        if (cached && canTrustCached && (await discordThroughProxy(cached)) !== null) return "proxy";
        if (await directDiscordReachable()) {
            log("Discord reachable directly — no proxy needed");
            phase("Discord доступен напрямую — подключаемся");
            return "direct";
        }
        log("Discord is blocked; searching for a working proxy…");
        phase("Ищем рабочий прокси…");
        await buildPool(true);
        if (!withinStartupDeadline()) return "none";
        const configuredUrl = parseCurrentRules((getConfig("proxyRules") ?? "").trim());
        const existing = configuredUrl ? proxyFromUrl(configuredUrl) : null;
        const trustExisting = existing && (existing.scheme === "http" || existing.scheme === "https");
        if (trustExisting && existing && (await discordThroughProxy(existing)) !== null) {
            state.currentUrl = existing.url;
            state.consecutiveFailures = 0;
            log(`reusing configured proxy ${existing.url}`);
            return "proxy";
        }
        const found = await findWorkingProxy(null);
        if (found) {
            await applyProxy(found.candidate);
            return "proxy";
        }
        if (Date.now() - startedAt > STARTUP_BUDGET_MS) {
            phase("Поиск прокси превышает лимит времени — продолжаем без прокси");
            logError("startup proxy search exceeded 14s budget — aborting check");
            return "none";
        }
        phase("Рабочий прокси не найден — продолжаем без прокси");
        logError("no working proxy found; Discord may fail to load");
        return "none";
    } catch (error) {
        phase("Ошибка поиска прокси — продолжаем без прокси");
        logError(error instanceof Error ? (error.stack ?? error.message) : String(error));
        return "none";
    } finally {
        startupDeadline = 0;
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
        // Hysteresis: avoid churning between similar proxies. Only switch on a
        // real improvement (or when the current one is down).
        if (!isDown && currentLatency !== null && found.ms >= currentLatency - 15) {
            log(`no meaningfully better proxy than current (${found.ms}ms vs ${currentLatency}ms)`);
            state.consecutiveFailures = 0;
            return;
        }
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
