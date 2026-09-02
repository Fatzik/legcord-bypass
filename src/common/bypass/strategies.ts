import { join } from "node:path";
import type { BypassStrategy } from "./types.js";

const HOSTLIST_LINES = [
    "discord.com",
    "*.discord.com",
    "canary.discord.com",
    "ptb.discord.com",
    "api.discord.com",
    "cdn.discord.com",
    "status.discord.com",
    "gateway.discord.gg",
    "discord.gg",
    "*.discord.gg",
    "discord.media",
    "*.discord.media",
    "discordapp.com",
    "*.discordapp.com",
    "discordapp.net",
    "*.discordapp.net",
].join("\n");

export const DISCORD_HOSTLIST_CONTENT = `${HOSTLIST_LINES}\n`;
export const DISCORD_HOSTLIST_FILENAME = "discord-list.txt";

const wfBase = "--wf-tcp=80,443,2053,2083,2087,2096,8443 --wf-udp=443,19294-19344,50000-50100".split(" ");

const tcpChain = (hostlist: string, pattern: string, seqovl: number): string[] => [
    `--filter-tcp=443`,
    `--hostlist=${hostlist}`,
    "--dpi-desync=multisplit",
    `--dpi-desync-split-seqovl=${seqovl}`,
    "--dpi-desync-split-pos=1",
    `--dpi-desync-split-seqovl-pattern=${pattern}`,
];

const mediaChain = (pattern: string, seqovl: number): string[] => [
    "--new",
    "--filter-tcp=443",
    "--hostlist-domains=discord.media",
    "--dpi-desync=multisplit",
    `--dpi-desync-split-seqovl=${seqovl}`,
    "--dpi-desync-split-pos=1",
    `--dpi-desync-split-seqovl-pattern=${pattern}`,
];

const udpDiscordChain = (dir: string): string[] => [
    "--new",
    "--filter-udp=19294-19344,50000-50100",
    "--filter-l7=discord,stun",
    "--dpi-desync=fake",
    `--dpi-desync-fake-discord=${join(dir, "bin", "ACTIVE_DISCORD_UDP.bin")}`,
    `--dpi-desync-fake-stun=${join(dir, "bin", "ACTIVE_DISCORD_UDP.bin")}`,
    "--dpi-desync-repeats=6",
];

const fakeChain = (hostlist: string, repeats: number, anyProtocol: boolean): string[] => [
    "--filter-tcp=443",
    `--hostlist=${hostlist}`,
    "--dpi-desync=fake",
    `--dpi-desync-repeats=${repeats}`,
    ...(anyProtocol ? ["--dpi-desync-any-protocol=1"] : []),
];

/**
 * Discord-only winws strategies, ported from Flowseal/zapret-discord-youtube
 * general*.bat chains and trimmed to Discord hostnames + voice UDP.
 */
export const strategies: BypassStrategy[] = [
    {
        id: "fake-tls",
        label: "fake-tls · multisplit 681",
        args: (dir) => {
            const hostlist = join(dir, DISCORD_HOSTLIST_FILENAME);
            const pattern = join(dir, "bin", "tls_clienthello_www_google_com.bin");
            return [
                ...wfBase,
                ...tcpChain(hostlist, pattern, 681),
                ...mediaChain(pattern, 681),
                ...udpDiscordChain(dir),
            ];
        },
    },
    {
        id: "fake-tls-alt",
        label: "fake-tls · multisplit 568",
        args: (dir) => {
            const hostlist = join(dir, DISCORD_HOSTLIST_FILENAME);
            const pattern = join(dir, "bin", "tls_clienthello_4pda_to.bin");
            return [
                ...wfBase,
                ...tcpChain(hostlist, pattern, 568),
                ...mediaChain(pattern, 568),
                ...udpDiscordChain(dir),
            ];
        },
    },
    {
        id: "fake",
        label: "fake · repeats 6",
        args: (dir) => [
            ...wfBase,
            ...fakeChain(join(dir, DISCORD_HOSTLIST_FILENAME), 6, false),
            ...udpDiscordChain(dir),
        ],
    },
    {
        id: "fake-simple",
        label: "fake · repeats 11",
        args: (dir) => [
            ...wfBase,
            ...fakeChain(join(dir, DISCORD_HOSTLIST_FILENAME), 11, false),
            ...udpDiscordChain(dir),
        ],
    },
    {
        id: "fake-anyproto",
        label: "fake · any-protocol",
        args: (dir) => [
            ...wfBase,
            ...fakeChain(join(dir, DISCORD_HOSTLIST_FILENAME), 6, true),
            ...udpDiscordChain(dir),
        ],
    },
];
