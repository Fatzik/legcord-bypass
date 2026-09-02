import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app } from "electron";
import { getConfig, setConfig } from "../config.js";
import { probeDiscord } from "./probe.js";
import { strategies } from "./strategies.js";
import type { BypassSnapshot, BypassStage, BypassStrategy, BypassUpdate } from "./types.js";
import * as task from "./winTask.js";
import type { LatestRelease } from "./zapretFiles.js";
import { fetchLatestRelease } from "./zapretFiles.js";

const runtimeRoot = (): string => join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "Legcord", "zapret");
const bypassDir = (): string => join(app.getPath("userData"), "zapret-bypass");
const idFilePath = (): string => join(bypassDir(), "active.id");
const localZipPath = (): string => join(bypassDir(), "bundle.zip");
const tagCachePath = (): string => join(bypassDir(), "last-tag.txt");

function readTagCache(): string | null {
    try {
        const raw = readFileSync(tagCachePath(), "utf-8").trim();
        return raw || null;
    } catch {
        return null;
    }
}

function writeTagCache(tag: string): void {
    try {
        mkdirSync(dirname(tagCachePath()), { recursive: true });
        writeFileSync(tagCachePath(), `${tag}\n`, "utf-8");
    } catch {
        // non-fatal
    }
}

let lastSnapshot: BypassSnapshot = { stage: "disabled", detail: "", strategy: "", tried: 0, total: 0 };
const listeners = new Set<BypassUpdate>();
let busy = false;

const log = (message: string): void => console.log(`[Bypass] ${message}`);
const logError = (message: string): void => console.error(`[Bypass] ${message}`);

function emit(snapshot: BypassSnapshot): void {
    lastSnapshot = snapshot;
    for (const listener of listeners) listener(snapshot);
}

function snapshot(stage: BypassStage, detail: string, strategy = "", tried = 0, total = 0): BypassSnapshot {
    return { stage, detail, strategy, tried, total };
}

export function onBypassUpdate(cb: BypassUpdate): () => void {
    listeners.add(cb);
    cb(lastSnapshot);
    return () => listeners.delete(cb);
}

export function getBypassSnapshot(): BypassSnapshot {
    return lastSnapshot;
}

/** The bypass is on by default in this fork; only an explicit "false" disables it. */
export function isBypassEnabled(): boolean {
    const settings = getConfig("bypass");
    return settings === undefined || settings.enabled === true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function orderedCandidates(): BypassStrategy[] {
    const saved = getConfig("bypass")?.strategy;
    const ordered = [...strategies];
    if (saved) {
        const savedIdx = ordered.findIndex((s) => s.id === saved);
        if (savedIdx > 0) {
            const [first] = ordered.splice(savedIdx, 1);
            ordered.unshift(first);
        }
    }
    return ordered;
}

async function reachableWithRetries(attempts: number, delayMs: number): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(delayMs);
        const result = await probeDiscord(3000);
        log(`probe ${i + 1}/${attempts}: reachable=${result.reachable} online=${result.online} (${result.detail})`);
        if (result.reachable) return true;
    }
    return false;
}

function setupOptions(release: LatestRelease): task.ElevatedSetupOptions {
    return {
        runtimeDir: runtimeRoot(),
        idFilePath: idFilePath(),
        tag: release.tag,
        url: release.url,
        ...(existsSync(localZipPath()) ? { localZip: localZipPath() } : {}),
    };
}

/** @returns null when the runtime is ready, otherwise a diagnostic message. */
async function ensureSetup(release: LatestRelease): Promise<string | null> {
    const options = setupOptions(release);
    if ((await task.isTaskInstalled()) && task.isRuntimeCurrent(options) && task.isRuntimePresent(options.runtimeDir)) {
        log("runtime is current, skipping elevated setup");
        return null;
    }
    log("elevated setup required (task/version mismatch or missing runtime)");
    emit(snapshot("installing", "Настройка обхода…\nПодтвердите запрос администратора"));
    let setupFinished = false;
    const applying = task.applyElevatedSetup(options);
    const heartbeat = (async () => {
        const messages = [
            "Установка движка обхода…",
            "Установка движка обхода…\nЭто может занять до минуты",
            "Установка движка обхода…\n(сеть нестабильна, используем зеркала)",
            "Установка движка обхода…\nПодтвердите запрос администратора при появлении",
        ];
        for (let i = 0; i < 30; i++) {
            await sleep(4000);
            if (setupFinished) return;
            emit(snapshot("installing", messages[i % messages.length]));
        }
    })();
    const result = await applying;
    setupFinished = true;
    void heartbeat;
    if (result !== null) logError(`elevated setup failed: ${result}`);
    return result;
}

async function tryStrategy(strategy: BypassStrategy, index: number, total: number): Promise<boolean> {
    emit(snapshot("testing", `Пробуем стратегию «${strategy.label}»…`, strategy.id, index + 1, total));
    log(`testing strategy ${index + 1}/${total} '${strategy.id}'`);
    await task.writeActiveId(idFilePath(), strategy.id);
    if (!(await task.runTask())) {
        logError(`could not start bypass task for strategy '${strategy.id}'`);
        return false;
    }
    await sleep(1000);
    return reachableWithRetries(1, 0);
}

async function alreadyRunningAndReachable(): Promise<boolean> {
    const running = (await task.isTaskRunning()) || (await task.isWinwsRunningUnder(runtimeRoot()));
    log(`existing bypass process: running=${running}`);
    if (!running) return false;
    return reachableWithRetries(2, 1000);
}

export async function startBypassForLaunch(): Promise<BypassSnapshot> {
    if (process.platform !== "win32") {
        emit(snapshot("disabled", ""));
        return lastSnapshot;
    }
    const rawSettings = getConfig("bypass");
    // This fork is built around the bypass: it is ON unless explicitly disabled
    // (settings.json `"bypass": { "enabled": false }` or the `--no-bypass` flag).
    const settings = rawSettings === undefined ? { enabled: true, strategy: "", installed: false } : rawSettings;
    if (!settings.enabled) {
        log("disabled in settings, skipping");
        emit(snapshot("disabled", ""));
        return lastSnapshot;
    }
    if (busy) return lastSnapshot;
    busy = true;
    log("machine started");

    emit(snapshot("checking", "Проверяем доступность Discord…"));

    const initial = await probeDiscord(4000);
    log(`initial probe: reachable=${initial.reachable} online=${initial.online} (${initial.detail})`);
    if (initial.reachable) {
        busy = false;
        log("Discord reachable directly, no bypass needed");
        emit(snapshot("direct", "Discord доступен напрямую, обход не нужен"));
        return lastSnapshot;
    }
    if (!initial.online) {
        busy = false;
        logError("internet seems down");
        emit(snapshot("error", "Нет подключения к интернету"));
        return lastSnapshot;
    }

    try {
        let release: LatestRelease;
        if (existsSync(localZipPath())) {
            // Offline mode: a pre-downloaded bundle zip is provided by the user,
            // so we do not need GitHub reachability for the release metadata.
            release = { tag: "offline", url: "" };
            log("offline bundle detected, skipping GitHub release lookup");
        } else {
            const cachedTag = readTagCache();
            const alreadyCurrent =
                cachedTag !== null &&
                (await task.isTaskInstalled()) &&
                task.isRuntimePresent(runtimeRoot()) &&
                task.isRuntimeCurrent({
                    runtimeDir: runtimeRoot(),
                    idFilePath: idFilePath(),
                    tag: cachedTag,
                    url: "",
                });
            if (alreadyCurrent) {
                // Fast path: the installed engine matches the cached tag, so the
                // whole launch skips the GitHub API round-trip entirely.
                release = { tag: cachedTag, url: "" };
                log(`runtime already current (${cachedTag}), skipping release lookup`);
            } else {
                emit(snapshot("installing", "Проверяем актуальность движка…"));
                release = await fetchLatestRelease();
                log(`latest flowseal release: ${release.tag}`);
            }
        }
        const setupError = await ensureSetup(release);
        if (setupError !== null) {
            busy = false;
            logError(`setup failed: ${setupError}`);
            emit(snapshot("error", `Установка обхода не выполнена: ${setupError}`));
            return lastSnapshot;
        }
        writeTagCache(release.tag);

        if (await alreadyRunningAndReachable()) {
            const saved = getConfig("bypass")?.strategy ?? "";
            setConfig("bypass", { ...settings, strategy: saved, installed: true });
            busy = false;
            log(`active via already-running bypass (${saved})`);
            emit(snapshot("active", `Обход активен · ${saved}`, saved, 1, 1));
            return lastSnapshot;
        }

        const candidates = orderedCandidates();
        let lastError = "";
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            if (candidate === undefined) continue;
            try {
                const worked = await tryStrategy(candidate, i, candidates.length);
                if (worked) {
                    setConfig("bypass", { ...settings, strategy: candidate.id, installed: true });
                    busy = false;
                    log(`strategy '${candidate.id}' works, bypass active`);
                    emit(
                        snapshot(
                            "active",
                            `Обход активен · ${candidate.label}`,
                            candidate.id,
                            i + 1,
                            candidates.length,
                        ),
                    );
                    return lastSnapshot;
                }
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
                logError(`strategy '${candidate.id}' errored: ${lastError}`);
            }
            log(`strategy '${candidate.id}' did not work, trying next`);
            emit(
                snapshot("testing", "Стратегия не подошла, пробуем следующую…", candidate.id, i + 1, candidates.length),
            );
            await task.endTask();
        }

        busy = false;
        const detail = lastError
            ? `Не удалось обойти блокировку (${lastError}). Включите Secure DNS (DoH) в системе и повторите запуск.`
            : "Ни одна стратегия не подошла. Включите Secure DNS (DoH) в системе и повторите запуск.";
        logError(`all strategies failed: ${detail}`);
        emit(snapshot("error", detail));
        return lastSnapshot;
    } catch (error) {
        busy = false;
        const detail = error instanceof Error ? error.message : String(error);
        logError(`machine error: ${detail}`);
        emit(snapshot("error", `Ошибка обхода: ${detail}`));
        return lastSnapshot;
    }
}

export async function stopBypass(): Promise<void> {
    log("stopping bypass");
    await task.endTask();
    await task.killWinwsUnder(runtimeRoot());
    busy = false;
    emit(snapshot("disabled", "Обход остановлен"));
}
