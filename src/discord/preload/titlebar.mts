const { ipcRenderer } = require("electron");

import type { Settings } from "../../@types/settings.js";
import { addStyle } from "../../common/dom.js";

const titlebarHTML = `<nav class="titlebar">
          <div class="window-title" id="window-title"></div>
          <div id="window-controls-container">
              <div id="spacer"></div>
              <div id="minimize"><div id="minimize-icon"></div></div>
              <div id="maximize"><div id="maximize-icon"></div></div>
              <div id="quit"><div id="quit-icon"></div></div>
          </div>
        </nav>`;
const titlebarOverlayHTML = `<nav class="titlebar">
          <div class="window-title" id="window-title"></div>
        </nav>`;
function injectTitlebar(isOverlay?: boolean): void {
    window.onload = () => {
        const elem = document.createElement("div");
        if (isOverlay) {
            if ((ipcRenderer.sendSync("getOS") as string) === "darwin")
                return document.body.setAttribute("class", "platform-osx");
            elem.innerHTML = titlebarOverlayHTML;
        } else {
            elem.innerHTML = titlebarHTML;
        }
        document.body.prepend(elem);
        addStyle("legcord://assets/css/titlebar.css");

        const minimize = document.getElementById("minimize");
        const maximize = document.getElementById("maximize");
        const quit = document.getElementById("quit");

        minimize!.addEventListener("click", () => {
            if (window.location.href.includes("setup.html")) {
                ipcRenderer.send("setup-minimize");
            } else {
                ipcRenderer.send("win-minimize");
            }
        });

        maximize!.addEventListener("click", () => {
            if (ipcRenderer.sendSync("win-isMaximized") === true) {
                ipcRenderer.send("win-unmaximize");
                document.body.removeAttribute("isMaximized");
            } else if (ipcRenderer.sendSync("win-isNormal") === true) {
                ipcRenderer.send("win-maximize");
            }
        });
        const minimizeToTray = ipcRenderer.sendSync("getConfig", "minimizeToTray") as Settings["minimizeToTray"];
        quit!.addEventListener("click", () => {
            if (window.location.href.includes("setup.html")) {
                ipcRenderer.send("setup-quit");
            } else {
                if (minimizeToTray === true) {
                    ipcRenderer.send("win-hide");
                } else if (minimizeToTray === false) {
                    ipcRenderer.send("win-quit");
                }
            }
        });
    };
}

switch (ipcRenderer.sendSync("getConfig", "windowStyle")) {
    case "legacy":
        injectTitlebar(false);
        break;
    default:
        break;
}
