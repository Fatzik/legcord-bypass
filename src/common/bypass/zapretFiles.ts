export interface LatestRelease {
    tag: string;
    url: string;
}

const RELEASE_API = "https://api.github.com/repos/flowseal/zapret-discord-youtube/releases/latest";

interface GitHubRelease {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
}

export async function fetchLatestRelease(): Promise<LatestRelease> {
    const response = await fetch(RELEASE_API, {
        headers: { "user-agent": "legcord-bypass/1.0", accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch zapret releases (HTTP ${response.status})`);
    }
    const release = (await response.json()) as GitHubRelease;
    const asset = release.assets.find((a) => a.name.toLowerCase().endsWith(".zip"));
    if (!asset) {
        throw new Error("No .zip asset found in the latest flowseal/zapret release");
    }
    return { tag: release.tag_name, url: asset.browser_download_url };
}
