const { http } = shelter;

const cache = new Map<string, string | undefined>();
type Asset = { id: string; name: string; [key: string]: unknown };
const assetCache: { [key: number]: Asset[] } = {};
const appCache: { [key: number]: { id: number; name: string } } = {};
export async function fetchExternalAsset(applicationId: number, url: string): Promise<string | undefined> {
    await http.ready;
    if (cache.has(url)) {
        return cache.get(url);
    }
    const res = await http.post!({
        url: `/applications/${applicationId}/external-assets`,
        body: { urls: [url] },
        oldFormErrors: false,
    });

    if (res.ok) {
        const path = `mp:${res.body[0].external_asset_path}`;
        cache.set(url, path);
        return path;
    }
    cache.set(url, undefined);
    return "";
}

export async function fetchAssetId(applicationId: number, assetName: string): Promise<string | null> {
    await http.ready;
    if (!assetCache[applicationId]) {
        try {
            const response = await http.get!(`/oauth2/applications/${applicationId}/assets`);
            if (response.status !== 200) {
                console.error("Error fetching resources");
                return null;
            }
            assetCache[applicationId] = response.body;
        } catch (error) {
            console.error("Request failed", error);
            return null;
        }
    }
    const resource = assetCache[applicationId].find((item) => item.name === assetName);
    return resource ? resource.id : null;
}

export async function fetchApp(applicationId: number): Promise<{ id: number; name: string }> {
    await http.ready;
    if (!appCache[applicationId]) {
        try {
            const response = await http.get!(`/oauth2/applications/${applicationId}/rpc`);
            appCache[applicationId] = response.body;
        } catch (error) {
            console.error("Request failed", error);
            return { id: applicationId, name: "Unknown" };
        }
    }
    return appCache[applicationId] || { id: applicationId, name: "Unknown" };
}
