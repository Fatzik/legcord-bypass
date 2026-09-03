import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    app,
    BrowserWindow,
    type BrowserWindowConstructorOptions,
    clipboard,
    dialog,
    type MessageBoxOptions,
    nativeImage,
    net,
    screen,
    shell,
} from "electron";
import contextMenu from "electron-context-menu";
import { firstRun, getConfig, isBackgroundStart, setConfig } from "../common/config.js";
import { navigateTo } from "../common/dom.js";
import { forceQuit, setForceQuit } from "../common/forceQuit.js";
import { handleCommands, passedValidArgument } from "../common/handleCommands.js";
import { getLang } from "../common/lang.js";
import { forceProxySwitch } from "../common/proxySwitcher.js";
import {
    isBlockedLocalhostWebSocket,
    isDiscordIcsBlobUrl,
    isDiscordPopoutUrl,
    isTelemetryBlockedUrl,
    isYouTubeEmbedOrProxyFrame,
} from "../common/sanitization.js";
import { emitLaunchStatus } from "../common/startupBus.js";
import { injectThemesMain } from "../common/themes.js";
import {
    DEFAULT_WINDOW_HEIGHT,
    DEFAULT_WINDOW_WIDTH,
    MIN_WINDOW_HEIGHT,
    MIN_WINDOW_WIDTH,
    sanitizeWindowBounds,
} from "../common/windowBounds.js";
import { getWindowState, setWindowState } from "../common/windowState.js";
import { applyStartupWindowVisibility, revealWindow } from "../common/windowVisibility.js";
import { disconnectDbusService } from "../dbus.js";
import { init } from "../main.js";
import { registerGlobalKeybinds } from "./globalKeybinds.js";
import { registerIpc } from "./ipc.js";
import { setMenu } from "./menu.js";
import { startRPC, stopRPC } from "./rpcProcess.js";
import { registerCustomHandler } from "./screenshare.js";
import { mainTouchBar } from "./touchbar.js";
import { createTray, tray } from "./tray.js";
import { registerVenmicIpc } from "./venmic.js";
export let mainWindows: BrowserWindow[] = [];
export let inviteWindow: BrowserWindow;

function getStoredWindowBounds() {
    return sanitizeWindowBounds(
        {
            width: getWindowState("width"),
            height: getWindowState("height"),
            x: getWindowState("x"),
            y: getWindowState("y"),
            displayId: getWindowState("displayId"),
        },
        screen.getAllDisplays(),
    );
}

// Save window bounds using the same API family we restore with.
// This avoids coordinate-space mismatches caused by getNormalBounds()/setBounds() across DPI setups.
function saveWindowState(win: BrowserWindow): void {
    try {
        const [x, y] = win.getPosition();
        const [width, height] = win.getSize();
        const sanitized = sanitizeWindowBounds(
            {
                width,
                height,
                x,
                y,
                displayId: screen.getDisplayNearestPoint({ x, y }).id,
            },
            screen.getAllDisplays(),
        );

        setWindowState({
            width: sanitized.width,
            height: sanitized.height,
            isMaximized: win.isMaximized(),
            x: sanitized.x,
            y: sanitized.y,
            displayId: sanitized.displayId,
            displayScaleFactor: sanitized.displayScaleFactor,
        });
    } catch (e) {
        console.log("[Window] Failed to save window state:", e);
    }
}

async function copyImageFromContext(
    parameters: { srcURL: string; x: number; y: number },
    win?: BrowserWindow,
): Promise<void> {
    if (parameters.srcURL) {
        try {
            const response = await net.fetch(parameters.srcURL);
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

            const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
            if (!image.isEmpty()) {
                clipboard.writeImage(image);
                return;
            }
        } catch (error) {
            console.warn("[ContextMenu] Failed to copy image from URL, falling back to copyImageAt:", error);
        }
    }

    win?.webContents.copyImageAt(parameters.x, parameters.y);
}

contextMenu({
    showSaveImageAs: true,
    showCopyImage: false,
    showCopyImageAddress: true,
    showSearchWithGoogle: false,
    append: (_defaultActions, parameters, win) => [
        {
            label: "Copy Image",
            visible: parameters.mediaType === "image",
            click: () => {
                void copyImageFromContext(parameters, win as BrowserWindow | undefined);
            },
        },
    ],
    prepend: (_defaultActions, parameters) => [
        {
            label: getLang("contextMenu-searchGoogle"),
            // Only show it when right-clicking text
            visible: parameters.selectionText.trim().length > 0,
            click: () => {
                void shell.openExternal(`https://google.com/search?q=${encodeURIComponent(parameters.selectionText)}`);
            },
        },
        {
            label: getLang("contextMenu-searchDuckDuckGo"),
            // Only show it when right-clicking text
            visible: parameters.selectionText.trim().length > 0,
            click: () => {
                void shell.openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(parameters.selectionText)}`);
            },
        },
    ],
});
function doAfterDefiningTheWindow(passedWindow: BrowserWindow): void {
    if (getWindowState("isMaximized") ?? false) {
        passedWindow.setSize(DEFAULT_WINDOW_WIDTH, DEFAULT_WINDOW_HEIGHT); //just so the whole thing doesn't cover whole screen
        passedWindow.maximize();
        void passedWindow.webContents.executeJavaScript(`document.body.setAttribute("isMaximized", "");`);
        passedWindow.hide(); // please don't flashbang the user
    }

    // REVIEW - Test the protocol warning. I was not sure how to get it to pop up. For now I've voided the promises.

    const ignoreProtocolWarning = getConfig("ignoreProtocolWarning");
    registerIpc(passedWindow);
    registerVenmicIpc();
    if (getConfig("mobileMode")) {
        passedWindow.webContents.userAgent =
            "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.5005.149 Mobile Safari/537.36";
    } else {
        let osType = process.platform === "darwin" ? "Macintosh" : process.platform === "win32" ? "Windows" : "Linux";
        if (osType === "Linux") osType = `X11; ${osType}`;
        const chromeVersion = process.versions.chrome;
        const userAgent = `Mozilla/5.0 (${osType} ${os.arch()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
        passedWindow.webContents.userAgent = userAgent;
    }
    if (mainWindows.length === 1) {
        app.on("second-instance", (_event, commandLine, _workingDirectory, additionalData) => {
            void (async () => {
                // Print out data received from the second instance.
                console.log(`data received: ${additionalData}`);

                if (!getConfig("multiInstance")) {
                    // Someone tried to run a second instance,
                    // we should focus our window if the user is not running special commands.
                    if (passedWindow && !passedValidArgument(commandLine)) {
                        if (passedWindow.isMinimized()) passedWindow.restore();
                        revealWindow(passedWindow);
                    }
                    if (commandLine && commandLine.length > 0) {
                        handleCommands(commandLine);
                        const lastArg = commandLine.pop();
                        if (lastArg?.startsWith("discord://-")) {
                            navigateTo(passedWindow, lastArg.replace("discord://-", ""));
                        }
                    }
                } else {
                    await init();
                }
            })();
        });
    }
    app.on("activate", async () => {
        app.show();
    });
    passedWindow.webContents.on("frame-created", (_, { frame }) => {
        if (!frame) {
            return;
        }
        frame.once("dom-ready", async () => {
            if (isYouTubeEmbedOrProxyFrame(frame.url)) {
                await frame.executeJavaScript(readFileSync(path.join(__dirname, "assets/js/adguard.js"), "utf-8"));
            }
        });
    });
    passedWindow.webContents.setWindowOpenHandler(({ url }) => {
        // Allow about:blank (used by Vencord & Equicord QuickCss popup)
        if (url === "about:blank") return { action: "allow" };
        // Saving ics files on future events
        if (isDiscordIcsBlobUrl(url)) {
            return {
                action: "allow",
                overrideBrowserWindowOptions: { show: false },
            };
        }
        // Allow Discord stream popout
        if (isDiscordPopoutUrl(url))
            return {
                action: "allow",
                overrideBrowserWindowOptions: {
                    alwaysOnTop: getConfig("popoutPiP"),
                },
            };
        if (url.startsWith("https:") || url.startsWith("http:") || url.startsWith("mailto:")) {
            void shell.openExternal(url);
        } else if (ignoreProtocolWarning) {
            void shell.openExternal(url);
        } else {
            const options: MessageBoxOptions = {
                type: "question",
                buttons: [getLang("dialog-openUrl-yes"), getLang("dialog-openUrl-no")],
                defaultId: 1,
                title: getLang("dialog-openUrl-title"),
                message: getLang("dialog-openUrl-message").replace("{url}", url),
                detail: getLang("dialog-openUrl-detail"),
                checkboxLabel: getLang("dialog-openUrl-checkbox"),
                checkboxChecked: false,
            };

            void dialog.showMessageBox(passedWindow, options).then(({ response, checkboxChecked }) => {
                console.log(response, checkboxChecked);
                if (checkboxChecked) {
                    if (response === 0) {
                        setConfig("ignoreProtocolWarning", true);
                    } else {
                        setConfig("ignoreProtocolWarning", false);
                    }
                }
                if (response === 0) {
                    void shell.openExternal(url);
                }
            });
        }

        return { action: "deny" };
    });

    passedWindow.webContents.session.setSpellCheckerLanguages(getConfig("spellcheckLanguage"));

    registerCustomHandler();

    passedWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        if (isTelemetryBlockedUrl(details.url) || isBlockedLocalhostWebSocket(details.url)) {
            return callback({ cancel: true });
        }
        return callback({});
    });

    // fix UMG video playback
    passedWindow.webContents.session.webRequest.onBeforeSendHeaders(
        { urls: ["https://www.youtube.com/embed/*"] },
        ({ requestHeaders }, callback) => {
            requestHeaders.Referer = "https://google.com";
            callback({ requestHeaders });
        },
    );
    if (getConfig("tray") === "dynamic") {
        passedWindow.webContents.on("page-favicon-updated", (_, favicons) => {
            try {
                let favicon = nativeImage.createFromDataURL(favicons[0]);

                switch (process.platform) {
                    case "darwin":
                        favicon = favicon.resize({ height: 22 });
                        break;
                    case "win32":
                        favicon = favicon.resize({ height: 32 });
                        break;
                }

                tray.setImage(favicon);
            } catch {
                return;
            }
        });
    }

    passedWindow.setTouchBar(mainTouchBar);
    app.on("open-url", (_event, url) => {
        navigateTo(passedWindow, url.replace("discord://-", ""));
    });

    passedWindow.webContents.on("page-title-updated", (e, title) => {
        const legcordSuffix = " - Legcord";
        const unreadMessages = getLang("title-unreadMessages");

        // Helper to extract ping count from title
        const extractPings = (t: string): number | null => {
            const match = /\((\d+)\)/.exec(t);
            return match ? Number.parseInt(match[1], 10) : null;
        };

        // Handle overlay icon/badges based on platform
        if (process.platform === "win32") {
            if (title.startsWith("•")) {
                passedWindow.setOverlayIcon(
                    nativeImage.createFromPath(path.join(import.meta.dirname, "../", "/assets/badge-11.ico")),
                    unreadMessages,
                );
            } else if (title.startsWith("(")) {
                const pings = extractPings(title);
                const badgeFile = pings && pings > 9 ? "badge-10.ico" : `badge-${pings}.ico`;
                passedWindow.setOverlayIcon(
                    nativeImage.createFromPath(path.join(import.meta.dirname, "../", `/assets/${badgeFile}`)),
                    unreadMessages,
                );
            } else {
                passedWindow.setOverlayIcon(null, "");
            }
        }

        if (process.platform === "darwin") {
            if (title.startsWith("•")) {
                app.dock?.setBadge("•");
            } else if (title.startsWith("(")) {
                const pings = extractPings(title);
                if (pings && getConfig("bounceOnPing")) app.dock?.bounce();
                app.setBadgeCount(pings ?? 0);
            } else {
                app.setBadgeCount(0);
            }
        }

        // Update window title with Legcord suffix
        if (!title.endsWith(legcordSuffix)) {
            e.preventDefault();
            passedWindow.setTitle(title.replace("Discord |", "") + legcordSuffix);
        }
    });
    injectThemesMain(passedWindow);
    passedWindow.on("unresponsive", () => {
        passedWindow.webContents.reload();
    });

    setMenu();
    passedWindow.on("close", (e) => {
        if (mainWindows.length > 1) {
            mainWindows = mainWindows.filter((mainWindow) => mainWindow.id !== passedWindow.id);
            passedWindow.destroy();
        }
        if (getConfig("minimizeToTray") && !forceQuit) {
            // Save state when hiding to tray so we persist display metadata
            try {
                saveWindowState(passedWindow);
            } catch {}
            e.preventDefault();
            passedWindow.hide();
        } else if (!getConfig("minimizeToTray")) {
            app.quit();
        }
    });
    app.on("before-quit", () => {
        stopRPC();
        disconnectDbusService();
        try {
            // Ensure current window state is saved with display info
            if (passedWindow && !passedWindow.isDestroyed()) saveWindowState(passedWindow);
        } catch (e) {
            console.log("[Window] before-quit save failed:", e);
        }
        setForceQuit(true);
    });

    // also save on minimize in case of session shutdowns
    passedWindow.on("minimize", () => {
        try {
            saveWindowState(passedWindow);
        } catch {}
    });

    passedWindow.on("focus", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.removeAttribute("unFocused");`);
    });
    passedWindow.on("blur", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.setAttribute("unFocused", "");`);
    });

    passedWindow.on("maximize", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.setAttribute("isMaximized", "");`);
    });
    passedWindow.on("unmaximize", () => {
        void passedWindow.webContents.executeJavaScript(`document.body.removeAttribute("isMaximized");`);
    });
    if (getConfig("inviteWebsocket") && mainWindows.length === 1) {
        startRPC(passedWindow);
    }
    if (firstRun) {
        passedWindow.close();
    }

    registerGlobalKeybinds();
    // Persist bounds on move/resize with debounce to avoid frequent writes
    let _saveTimer: NodeJS.Timeout | null = null;
    const queueSave = () => {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => {
            try {
                saveWindowState(passedWindow);
            } catch (e) {
                console.log("[Window] queueSave failed:", e);
            }
            _saveTimer = null;
        }, 500);
    };
    passedWindow.on("move", queueSave);
    passedWindow.on("resize", queueSave);

    // Fallback: periodic poll to detect bounds changes.
    // Compare raw getNormalBounds() values to detect movement;
    // saveWindowState normalizes to DIP where needed.
    let lastPolledBounds: { x: number; y: number; width: number; height: number } | null = null;
    const pollInterval = setInterval(() => {
        try {
            if (passedWindow.isDestroyed()) {
                clearInterval(pollInterval);
                return;
            }
            const { x, y, width, height } = passedWindow.getNormalBounds();
            if (
                !lastPolledBounds ||
                lastPolledBounds.x !== x ||
                lastPolledBounds.y !== y ||
                lastPolledBounds.width !== width ||
                lastPolledBounds.height !== height
            ) {
                lastPolledBounds = { x, y, width, height };
                saveWindowState(passedWindow);
            }
        } catch (_e) {
            // ignore transient errors
        }
    }, 1000);
    passedWindow.on("closed", () => clearInterval(pollInterval));
    switch (getConfig("channel")) {
        case "stable":
            void passedWindow.loadURL("https://discord.com/app");
            break;
        case "canary":
            void passedWindow.loadURL("https://canary.discord.com/app");
            break;
        case "ptb":
            void passedWindow.loadURL("https://ptb.discord.com/app");
            break;
        default:
            void passedWindow.loadURL("https://discord.com/app");
            break;
    }

    // When splash won't run, finalize visibility here (splashEnd never fires).
    if (getConfig("skipSplash") || isBackgroundStart()) {
        createTray();
        applyStartupWindowVisibility(passedWindow);
    }
}

export function createWindow() {
    const storedBounds = getStoredWindowBounds();
    if (storedBounds.usedFallback) {
        console.log("[Window] Stored bounds were invalid or off-screen; using sanitized placement", storedBounds);
    }
    const browserWindowOptions: BrowserWindowConstructorOptions = {
        // Use safe defaults for constructor; actual bounds applied via setPosition/setSize below
        width: DEFAULT_WINDOW_WIDTH,
        height: DEFAULT_WINDOW_HEIGHT,
        minWidth: MIN_WINDOW_WIDTH,
        minHeight: MIN_WINDOW_HEIGHT,
        title: "Legcord",
        show: false,
        darkTheme: true,
        icon: getConfig("customIcon") ?? path.join(import.meta.dirname, "../", "/assets/desktop.png"),
        frame: false,
        backgroundColor: "#202225",
        autoHideMenuBar: getConfig("autoHideMenuBar"),
        webPreferences: {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: getConfig("sleepInBackground"),
            preload: path.join(import.meta.dirname, "discord/preload.mjs"),
            spellcheck: getConfig("spellcheck"),
        },
    };
    switch (getConfig("windowStyle")) {
        case "default":
            if (os.platform() === "win32") {
                browserWindowOptions.titleBarStyle = "hidden";
                browserWindowOptions.titleBarOverlay = false;
            }
            break;
        case "native":
            // On macOS, frame:true + transparent/vibrancy makes the native title bar
            // and traffic lights invisible (Legcord#1095). Use overlay chrome instead.
            if (os.platform() === "darwin" && getConfig("transparency") !== "none") {
                browserWindowOptions.titleBarStyle = "hidden";
                browserWindowOptions.titleBarOverlay = {
                    color: getConfig("overlayButtonColor"),
                    symbolColor: "#99aab5",
                    height: 30,
                };
                browserWindowOptions.trafficLightPosition = {
                    x: 10,
                    y: 10,
                };
            } else {
                browserWindowOptions.frame = true;
            }
            break;
        case "overlay":
            browserWindowOptions.titleBarStyle = "hidden";
            browserWindowOptions.titleBarOverlay = {
                color: getConfig("overlayButtonColor"),
                symbolColor: "#99aab5",
                height: 30,
            };
            // IF OS release is Tahoe or newer
            if (Number.parseInt(os.release(), 10) >= 25) {
                browserWindowOptions.trafficLightPosition = {
                    x: 10,
                    y: 8.5,
                };
            } else {
                browserWindowOptions.trafficLightPosition = {
                    x: 10,
                    y: 10,
                };
            }
            break;
    }
    switch (getConfig("transparency")) {
        case "universal":
            browserWindowOptions.backgroundColor = "#00000000";
            browserWindowOptions.transparent = true;
            break;
        case "modern":
            if (os.platform() === "win32") {
                browserWindowOptions.backgroundColor = "#00000000";
                browserWindowOptions.transparent = false;
                browserWindowOptions.frame = true;
                browserWindowOptions.backgroundMaterial = getConfig("windowMaterial");
            } else if (os.platform() === "darwin") {
                browserWindowOptions.backgroundColor = "#00000000";
                browserWindowOptions.vibrancy = "fullscreen-ui";
                browserWindowOptions.transparent = true;
            }
            break;
        case "none":
            break;
    }
    const mainWindow = new BrowserWindow(browserWindowOptions);

    // Restore by position + size directly to match saveWindowState roundtrip.
    mainWindow.setPosition(storedBounds.x, storedBounds.y);
    mainWindow.setSize(storedBounds.width, storedBounds.height);

    mainWindows.push(mainWindow);

    // Startup watchdog: tell the splash whether Discord actually loaded, so the
    // user never stares at a black window after a failed/hung page load.
    let launchReported = false;
    let didRetryLoad = false;
    let launchRecoveryUsed = false;
    let okTimer: NodeJS.Timeout | null = null;
    const finishLaunch = (state: "ok" | "fail", detail = "") => {
        if (launchReported) return;
        launchReported = true;
        if (okTimer) clearTimeout(okTimer);
        clearTimeout(launchWatchdog);
        emitLaunchStatus(state, detail);
    };
    const launchWatchdog = setTimeout(() => finishLaunch("fail", "Timed out while waiting for Discord to load"), 35000);
    launchWatchdog.unref();

    mainWindow.webContents.on("did-finish-load", () => {
        // LOCAL anti-placebo check (no network): wait until Discord actually paints
        // real content (channels/guilds/chat). Loading through a slow/DPI'd proxy can
        // legitimately take a while, so be patient (up to ~25 s per committed document)
        // and only declare a "placebo" shell after one automatic proxy recovery round.
        if (launchReported) return;
        if (okTimer) clearTimeout(okTimer);
        okTimer = setTimeout(() => {
            void (async () => {
                if (launchReported || mainWindow.isDestroyed()) return;
                const contentProbe = `(() => {
                    const b = document.body;
                    if (!b) return false;
                    const title = (document.title || "").toLowerCase();
                    const text = (b.innerText || "").trim();
                    const structural =
                        b.querySelector('[class*=channels], [class*=sidebar], [class*=guilds], [class*=chat], [class*=messages]') !== null ||
                        b.querySelectorAll('img[src*="cdn.discord"], img[src*=discord]').length >= 3;
                    return title.includes("discord") && (structural || text.length > 250);
                })()`;
                const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
                const deadlineMs = launchRecoveryUsed ? 12000 : 25000;
                let probedFor = 0;
                while (!launchReported && !mainWindow.isDestroyed() && probedFor < deadlineMs) {
                    const hasContent = await mainWindow.webContents.executeJavaScript(contentProbe).catch(() => false);
                    if (hasContent === true) {
                        finishLaunch("ok");
                        return;
                    }
                    await wait(1500);
                    probedFor += 1500;
                }
                if (launchReported || mainWindow.isDestroyed()) return;
                // Discord shell loaded but stayed EMPTY for a long time. Before asking
                // the user for a new proxy, try ONE automatic route recovery round.
                if (launchRecoveryUsed) {
                    finishLaunch("fail", "Discord пустой (ничего не грузится) — введите новый прокси ниже");
                    return;
                }
                launchRecoveryUsed = true;
                await forceProxySwitch("Discord loaded but stayed empty").catch(() => false);
                if (!launchReported && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.reload();
                }
            })();
        }, 500);
    });
    mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
        if (launchReported) return;
        // -3 = navigation aborted (usually our own proxy switch / reload) — never a real failure.
        if (errorCode === -3) return;
        if (!didRetryLoad && getConfig("proxyAuto") !== false) {
            // A proxy swap can abort the first attempt; retry once before giving up.
            didRetryLoad = true;
            setTimeout(() => {
                if (!launchReported && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.reload();
                }
            }, 1200);
            return;
        }
        if (!launchRecoveryUsed && getConfig("proxyAuto") !== false) {
            // Second real load failure — find a better route and reload once.
            launchRecoveryUsed = true;
            void (async () => {
                await forceProxySwitch(`Discord failed to load (${errorCode})`).catch(() => false);
                if (!launchReported && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.reload();
                }
            })();
            return;
        }
        finishLaunch("fail", `${errorDescription} (${errorCode})`);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) =>
        finishLaunch("fail", `Renderer process gone: ${details.reason}`),
    );
    mainWindow.on("closed", () => {
        if (!launchReported) {
            if (okTimer) clearTimeout(okTimer);
            clearTimeout(launchWatchdog);
        }
    });

    // Health watchdog: watches the Discord UI for lost connections (reconnecting,
    // voice stuck on "Connecting", offline states) AND probes Discord's API from
    // main. On trouble it switches proxy, clicks "Reconnect", and reloads as a
    // last resort — Discord keeps working even if a route dies.
    const HEALTH_POLL_MS = 4000;
    const NET_PROBE_MS = 30000;
    let uiStreak = 0;
    let fixPending = false;
    let reloadedForHealth = false;

    const uiProbeScript = `(() => {
        if (!document.body) return { stuck: false, msgFail: false, hasReconnect: false };
        const text = (document.body.innerText || "").toLowerCase();
        const markers = [
            "подключение", "connecting", "rtc connecting", "reconnecting",
            "переподключение", "reconnect", "no route", "rtc disconnected",
            "не удаётся подключиться", "нет интернета", "no internet",
            "вы не в сети", "you are offline", "соединение с сервером потеряно",
            "trying to reconnect", "проблемы с подключением", "having trouble connecting",
            "сообщите нам", "let us know",
        ];
        const loadMarkers = [
            "не удалось загрузить сообщения", "failed to load messages",
            "не удалось загрузить канал", "failed to load channel",
            "сообщения не загрузились", "messages failed to load",
            "ошибка загрузки сообщений",
        ];
        const mediaMarkers = [
            "не удалось загрузить изображение", "failed to load image",
            "не удалось загрузить картинку", "картинка не загрузилась",
            "изображение не загрузилось", "не удалось загрузить файл",
            "failed to load file", "не удалось загрузить вложение", "failed to load attachment",
            "не удалось загрузить видео", "failed to load video",
            "не удалось воспроизвести", "failed to play",
            "не удалось загрузить превью", "failed to load preview",
            "не удалось загрузить", "couldn't load", "не удалось отобразить",
            "failed to load", "ошибка загрузки", "ошибка при загрузке",
            "не удалось подключиться", "failed to connect", "недоступно",
            "unavailable", "ошибка",
        ];
        const stuck = markers.some((m) => text.includes(m));
        const msgFail = loadMarkers.some((m) => text.includes(m));
        const mediaFail = mediaMarkers.some((m) => text.includes(m));
        const reconnect = Array.from(document.querySelectorAll("button,[role=button]")).find((el) => {
            const t = (el.textContent || "").trim().toLowerCase();
            return t === "reconnect" || t === "переподключиться" || t === "повторить" || t === "try again" || t === "retry";
        });
        return { stuck, msgFail, mediaFail, hasReconnect: !!reconnect };
    })()`;
    const clickReconnectScript = `(() => {
        const b = Array.from(document.querySelectorAll("button,[role=button]")).find((el) => {
            const t = (el.textContent || "").trim().toLowerCase();
            return t === "reconnect" || t === "переподключиться" || t === "повторить" || t === "try again" || t === "retry";
        });
        if (b) { b.click(); return true; }
        return false;
    })()`;

    const pollUiHealth = async (): Promise<void> => {
        try {
            if (getConfig("voiceAutoProxyFix") === false || getConfig("proxyAuto") === false) {
                uiStreak = 0;
                return;
            }
            const result = (await mainWindow.webContents.executeJavaScript(uiProbeScript)) as {
                stuck: boolean;
                msgFail: boolean;
                mediaFail: boolean;
                hasReconnect: boolean;
            };
            const bad =
                result?.stuck === true ||
                result?.msgFail === true ||
                result?.mediaFail === true ||
                result?.hasReconnect === true;
            uiStreak = bad ? uiStreak + 1 : 0;
            // Hard content-load failures (messages/media/images/voice) trigger FAST —
            // after 1 poll (~4 s). Generic connectivity waits a little (~8-12 s).
            const hardFail = result?.msgFail === true || result?.mediaFail === true;
            const requiredStreak = hardFail ? 1 : result?.hasReconnect === true ? 2 : 3;
            if (uiStreak < requiredStreak || fixPending) return;
            uiStreak = 0;
            fixPending = true;
            const reason =
                result?.msgFail === true
                    ? "messages failed to load"
                    : result?.mediaFail === true
                      ? "media/images/voice failed to load"
                      : "discord connection lost";
            const switched = await forceProxySwitch(reason);
            if (switched && !mainWindow.isDestroyed()) {
                const clicked = await mainWindow.webContents.executeJavaScript(clickReconnectScript).catch(() => false);
                if (!clicked && !reloadedForHealth) {
                    reloadedForHealth = true;
                    logHealthReload();
                    mainWindow.webContents.reload();
                }
            } else if (!switched && !reloadedForHealth) {
                reloadedForHealth = true;
                logHealthReload();
                mainWindow.webContents.reload();
            }
            setTimeout(() => {
                fixPending = false;
                reloadedForHealth = false;
            }, 30000);
        } catch {
            uiStreak = 0;
        }
    };

    let netFailStreak = 0;
    const pollNetworkHealth = async (): Promise<void> => {
        if (getConfig("proxyAuto") === false) return;
        try {
            const ok = (await mainWindow.webContents.executeJavaScript(
                `(async () => { try { const r = await fetch("/api/v9/gateway", { credentials: "omit", cache: "no-store" }); return r.ok; } catch { return false; } })()`,
            )) as boolean;
            if (ok) {
                netFailStreak = 0;
                return;
            }
            netFailStreak++;
            if (netFailStreak >= 3) {
                netFailStreak = 0;
                await forceProxySwitch("network probe: Discord unreachable");
            }
        } catch {
            netFailStreak = 0;
        }
    };

    const uiHealthTimer = setInterval(() => void pollUiHealth(), HEALTH_POLL_MS);
    const netHealthTimer = setInterval(() => void pollNetworkHealth(), NET_PROBE_MS);
    uiHealthTimer.unref();
    netHealthTimer.unref();
    const clearHealthTimers = () => {
        clearInterval(uiHealthTimer);
        clearInterval(netHealthTimer);
    };
    mainWindow.on("closed", clearHealthTimers);

    doAfterDefiningTheWindow(mainWindow);
}

function logHealthReload(): void {
    console.log("[HealthWatcher] Reloading Discord window after proxy fix attempt");
}
