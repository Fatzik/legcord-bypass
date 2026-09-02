import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { DISCORD_HOSTLIST_CONTENT, strategies } from "./strategies.js";

const execFileAsync = promisify(execFile);

export const TASK_NAME = "LegcordZapretBypass";
export const RUNNER_SCHEMA = "1";
const RUNNER_FILENAME = "bypass-runner.ps1";
const HOSTLIST_FILENAME = "discord-list.txt";
const MARKER_FILENAME = ".applied";
const ERROR_FILENAME = ".apply-error";
const MIRROR = "https://ghfast.top";

async function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
        const { stdout, stderr } = await execFileAsync(cmd, args, { windowsHide: true });
        return { code: 0, stdout, stderr };
    } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string };
        return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function isTaskInstalled(): Promise<boolean> {
    const { code } = await run("schtasks", ["/Query", "/TN", TASK_NAME]);
    return code === 0;
}

export async function isTaskRunning(): Promise<boolean> {
    const { code, stdout } = await run("schtasks", ["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]);
    if (code !== 0) return false;
    return stdout.split(/\r?\n/).some((line) => /^\s*Status:\s*Running\s*$/i.test(line));
}

export async function unregisterTask(): Promise<void> {
    await run("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
}

export async function runTask(): Promise<boolean> {
    const { code } = await run("schtasks", ["/Run", "/TN", TASK_NAME]);
    return code === 0;
}

/** Ends OUR scheduled task tree (runner + its winws child) — never touches foreign winws processes. */
export async function endTask(): Promise<void> {
    await run("schtasks", ["/End", "/TN", TASK_NAME]);
}

/** Kill only winws processes whose image lives under our admin-protected runtime dir. */
export async function killWinwsUnder(runtimeDir: string): Promise<void> {
    const filter = runtimeDir.replaceAll("\\", "\\\\");
    const command = `Get-Process winws -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${filter}\\*' } | Stop-Process -Force`;
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
}

export async function isWinwsRunningUnder(runtimeDir: string): Promise<boolean> {
    const filter = runtimeDir.replaceAll("\\", "\\\\");
    const command = `(Get-Process winws -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${filter}\\*' }).Count -gt 0`;
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
    return stdout.trim() === "True";
}

const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

function buildRunnerScript(idFilePath: string): string {
    const lines: string[] = [
        `$ErrorActionPreference = 'Stop'`,
        `$idFile = ${psQuote(idFilePath)}`,
        `if (-not (Test-Path -LiteralPath $idFile)) { exit 1 }`,
        `$id = (Get-Content -Raw -LiteralPath $idFile).Trim()`,
        `$winws = Join-Path $PSScriptRoot 'bin\\winws.exe'`,
        `if (-not (Test-Path -LiteralPath $winws)) { exit 3 }`,
        `switch ($id) {`,
    ];
    for (const strategy of strategies) {
        const args = strategy.args("@DIR@").map((arg) => {
            const expanded = arg.replaceAll("@DIR@", "$PSScriptRoot");
            return `            "${expanded}"`;
        });
        lines.push(`        '${strategy.id}' {`);
        lines.push(`            $runArgs = @(`);
        lines.push(args.join(",\n"));
        lines.push(`            )`);
        lines.push(`            break`);
        lines.push(`        }`);
    }
    lines.push(`        default { exit 2 }`);
    lines.push(`    }`);
    lines.push(`Set-Location -LiteralPath $PSScriptRoot`);
    lines.push(`& $winws $runArgs`);
    return lines.join("\n");
}

export interface ElevatedSetupOptions {
    runtimeDir: string;
    idFilePath: string;
    tag: string;
    url: string;
    /** Optional pre-downloaded bundle zip (used when GitHub release CDNs are unreachable). */
    localZip?: string;
}

/** True when the installed runtime matches the current bundle tag + runner schema. */
export function isRuntimeCurrent(options: ElevatedSetupOptions): boolean {
    const marker = join(options.runtimeDir, MARKER_FILENAME);
    if (!existsSync(marker)) return false;
    const stored = readFileSync(marker, "utf-8").trim();
    return stored === `${options.tag}|${RUNNER_SCHEMA}`;
}

export function isRuntimePresent(runtimeDir: string): boolean {
    const runner = join(runtimeDir, RUNNER_FILENAME);
    const winws = join(runtimeDir, "bin", "winws.exe");
    return existsSync(runner) && existsSync(winws);
}

export function readApplyError(runtimeDir: string): string {
    const errorFile = join(runtimeDir, ERROR_FILENAME);
    if (!existsSync(errorFile)) return "";
    return readFileSync(errorFile, "utf-8").trim();
}

function buildSetupScript(options: ElevatedSetupOptions): string {
    const runner = buildRunnerScript(options.idFilePath);
    const mirrorUrl = `${MIRROR}${options.url}`;
    const lines = [
        `$ErrorActionPreference = 'Stop'`,
        `$runtime = ${psQuote(options.runtimeDir)}`,
        `$url = ${psQuote(options.url)}`,
        `$mirrorUrl = ${psQuote(mirrorUrl)}`,
        `$localZip = ${psQuote(options.localZip ?? "")}`,
        `$markerValue = ${psQuote(`${options.tag}|${RUNNER_SCHEMA}`)}`,
        `$errorFile = Join-Path $runtime ${psQuote(ERROR_FILENAME)}`,
        `function Write-Fail([string]$msg) { try { $msg | Set-Content -Encoding utf8 -LiteralPath $errorFile } catch { } }`,
        `$runner = @'`,
        runner,
        `'@`,
        `$hostlist = @'`,
        DISCORD_HOSTLIST_CONTENT.replaceAll("'@", ""),
        `'@`,
        `New-Item -ItemType Directory -Force -Path $runtime | Out-Null`,
        `$tmp = Join-Path $env:TEMP ('legcord-zapret-' + [guid]::NewGuid().ToString('N'))`,
        `New-Item -ItemType Directory -Force -Path $tmp | Out-Null`,
        `try {`,
        `    $zip = Join-Path $tmp 'bundle.zip'`,
        `    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`,
        `    if ($localZip -and (Test-Path -LiteralPath $localZip)) {`,
        `        Copy-Item -LiteralPath $localZip -Destination $zip -Force`,
        `    } else {`,
        `        $downloaded = $false`,
        `        foreach ($candidate in @($url, $mirrorUrl)) {`,
        `            try {`,
        `                Invoke-WebRequest -UseBasicParsing -Uri $candidate -OutFile $zip -TimeoutSec 120`,
        `                $downloaded = $true`,
        `                break`,
        `            } catch { }`,
        `        }`,
        `        if (-not $downloaded) { throw 'download of the zapret bundle failed (all sources unreachable)' }`,
        `    }`,
        `    $extract = Join-Path $tmp 'x'`,
        `    New-Item -ItemType Directory -Force -Path $extract | Out-Null`,
        `    Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force`,
        `    $src = Get-ChildItem -LiteralPath $extract -Directory -Recurse | Where-Object { Test-Path (Join-Path $_.FullName 'bin\\winws.exe') } | Select-Object -First 1`,
        `    if (-not $src) { throw 'winws.exe not found in the release archive' }`,
        `    robocopy $src.FullName $runtime /MIR /NFL /NDL /NJH /NJS /NP | Out-Null`,
        `    $rc = $LASTEXITCODE`,
        `    if ($rc -gt 7) { throw ('robocopy failed with code ' + $rc) }`,
        `    Set-Content -Encoding utf8 -LiteralPath (Join-Path $runtime '${RUNNER_FILENAME}') -Value $runner`,
        `    Set-Content -Encoding utf8 -LiteralPath (Join-Path $runtime '${HOSTLIST_FILENAME}') -Value $hostlist`,
        `    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'bin\\winws.exe'))) { throw 'winws.exe is missing after install' }`,
        `    $taskAction = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $runtime '${RUNNER_FILENAME}') + '"'`,
        `    schtasks /Create /F /TN '${TASK_NAME}' /TR $taskAction /SC ONLOGON /RL HIGHEST`,
        `    if ($LASTEXITCODE -ne 0) { throw ('schtasks failed with code ' + $LASTEXITCODE) }`,
        `    $markerValue | Set-Content -Encoding ascii -LiteralPath (Join-Path $runtime '${MARKER_FILENAME}')`,
        `    Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue`,
        `} catch {`,
        `    Write-Fail $_.Exception.Message`,
        `    exit 1`,
        `} finally {`,
        `    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue`,
        `}`,
    ];
    return lines.join("\n");
}

/**
 * Elevated setup with a single UAC: downloads the release into an admin-owned
 * temp dir, installs it into the admin-protected runtime dir, writes the runner
 * and hostlist there, registers the auto-start task, and records the applied tag.
 * Nothing is executed from user-writable paths, so the task cannot be redirected.
 *
 * @returns null on success, or a diagnostic error message on failure.
 */
export async function applyElevatedSetup(options: ElevatedSetupOptions): Promise<string | null> {
    const script = buildSetupScript(options);
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const inner = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded];
    const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -ArgumentList @('${inner.join("','")}')`;
    const { code } = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command]);
    if (code !== 0) {
        return readApplyError(options.runtimeDir) || "Elevated setup was not started";
    }

    for (let i = 0; i < 40; i++) {
        if ((await isTaskInstalled()) && isRuntimeCurrent(options) && isRuntimePresent(options.runtimeDir)) {
            return null;
        }
        await sleep(500);
    }
    return readApplyError(options.runtimeDir) || "Setup finished but the bypass runtime is not active";
}

export async function writeActiveId(idFilePath: string, id: string): Promise<void> {
    mkdirSync(dirname(idFilePath), { recursive: true });
    writeFileSync(idFilePath, `${id}\n`, "utf-8");
}

/** Diagnostic helpers used to validate the generated PowerShell offline. */
export const diagnosticsRunnerScript = buildRunnerScript;
export const diagnosticsSetupScript = buildSetupScript;
