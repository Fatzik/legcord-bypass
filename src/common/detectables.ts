import fs from "node:fs";
import path from "node:path";
import type { Game, GameList } from "arrpc";
import { app } from "electron";
export function getDetectablesPath() {
    const userDataPath = app.getPath("userData");
    const storagePath = path.join(userDataPath, "/storage/");
    return `${storagePath}detectables.json`;
}
export function setDetectables(object: GameList): void {
    const toSave = JSON.stringify(object, null, 4);
    fs.writeFileSync(getDetectablesPath(), toSave, "utf-8");
}

export function addDetectable(object: Game): void {
    const currentDetectables = getDetectables();
    currentDetectables.push(object);
    setDetectables(currentDetectables);
}

export function removeDetectable(id: string): void {
    const currentDetectables = getDetectables().filter((g) => g.id !== id);
    setDetectables(currentDetectables);
}

export function getDetectables(): GameList {
    if (!fs.existsSync(getDetectablesPath())) {
        fs.writeFileSync(getDetectablesPath(), "[]", "utf-8");
    }
    const rawData = fs.readFileSync(getDetectablesPath(), "utf-8");
    const returnData = JSON.parse(rawData) as GameList;
    console.log(`[Detectables] Loaded ${returnData.length} custom detectables`);
    return returnData;
}
