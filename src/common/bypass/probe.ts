import { request } from "node:https";

const CONTROL_URLS = ["https://www.cloudflare.com/"];
const DISCORD_URLS = [
    "https://discord.com/api/v9/gateway",
    "https://api.discord.com/api/v9/gateway",
    "https://cdn.discord.com/",
];

export interface ProbeResult {
    reachable: boolean;
    online: boolean;
    latencyMs: number;
    detail: string;
}

interface TimedOutcome {
    ok: boolean;
    ms: number;
}

function timedGet(url: string, timeoutMs: number): Promise<TimedOutcome> {
    return new Promise((resolve) => {
        const started = Date.now();
        const req = request(url, { method: "GET", headers: { "user-agent": "legcord-bypass-probe/1.0" } }, (res) => {
            res.resume();
            resolve({ ok: true, ms: Date.now() - started });
        });
        const timer = setTimeout(() => {
            req.destroy();
            resolve({ ok: false, ms: timeoutMs });
        }, timeoutMs);
        timer.unref();
        req.on("error", () => {
            clearTimeout(timer);
            resolve({ ok: false, ms: Date.now() - started });
        });
        req.end();
    });
}

async function anyOk(urls: string[], timeoutMs: number): Promise<TimedOutcome> {
    const outcomes = await Promise.all(urls.map((url) => timedGet(url, timeoutMs)));
    const fastest = outcomes.reduce((a, b) => (a.ms <= b.ms ? a : b), outcomes[0]);
    return { ok: outcomes.some((o) => o.ok), ms: fastest?.ms ?? timeoutMs };
}

export async function probeDiscord(timeoutMs = 4000): Promise<ProbeResult> {
    const control = await anyOk(CONTROL_URLS, timeoutMs);
    if (!control.ok) {
        return { reachable: false, online: false, latencyMs: control.ms, detail: "network-down" };
    }
    const discord = await anyOk(DISCORD_URLS, timeoutMs);
    return {
        reachable: discord.ok,
        online: true,
        latencyMs: discord.ok ? discord.ms : control.ms,
        detail: discord.ok ? "ok" : "blocked",
    };
}
