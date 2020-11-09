import { promisify } from 'util'
import parseTorrent from 'parse-torrent'
import { Logger } from 'winston'
import { lookup } from 'mime-types'
import { BadRequest } from 'http-errors'

import { downloadTrackers, TorrentAdapter, TorrentAdapterTorrent, TorrentAdapterFile, WebtorrentAdapter } from '.'

export interface TorrentClientTorrent extends TorrentAdapterTorrent {
    created: Date
    updated: Date
    infoHash: string
    link: string
    files: TorrentClientFile[]
}

export interface TorrentClientFile extends TorrentAdapterFile {
    type: string
}

export interface TorrentClientConfig {
    trackers?: string[]
    autocleanInternal: number
    path: string
    logger: Logger
}

export class TorrentClient {
    protected torrents: Record<string, TorrentClientTorrent> = {}
    protected cleanLocked: boolean = false

    constructor(
        protected config: TorrentClientConfig,
        protected adapter: TorrentAdapter
    ) {}

    static async create(config: TorrentClientConfig, adapter?: TorrentAdapter): Promise<TorrentClient> {
        return new TorrentClient({
            ...config,
            trackers: await downloadTrackers().catch(() => {
                config.logger.warn('Failed to load tracker list')
                return []
            })
        }, adapter || new WebtorrentAdapter())
    }

    getTorrents(): TorrentClientTorrent[] {
        return Object.values(this.torrents)
    }

    getTorrent(infoHash: string): TorrentClientTorrent | undefined {
        return this.torrents[infoHash]
    }

    async removeTorrent(infoHash: string): Promise<void> {
        const torrent = this.torrents[infoHash]
        if (torrent) {
            await torrent.remove()
            delete this.torrents[infoHash]
        }
    }

    async addTorrent(link: string): Promise<TorrentClientTorrent> {
        let parsedLink: parseTorrent.Instance | undefined
        try {
            parsedLink = await promisify(parseTorrent.remote)(link)
        } catch (err) {
            throw new BadRequest(
                `Cannot parse torrent: ${err instanceof Error ? err.message : err}, link: ${link}`
            )
        }

        if (!parsedLink) {
            throw new BadRequest(`Cannot parse torrent: ${link}`)
        }

        const magnet = parseTorrent.toMagnetURI(parsedLink)
        const infoHash = parsedLink.infoHash

        if (infoHash in this.torrents) {
            this.torrents[infoHash] = {
                ...this.torrents[infoHash],
                updated: new Date(),
            }
            return this.torrents[infoHash]
        }

        const torrent = await this.adapter.add(magnet, this.config.path).then((v) => ({
            ...v,
            link,
            infoHash,
            created: new Date(),
            updated: new Date(),
            files: v.files.map((f) => ({
                ...f,
                type: lookup(f.name) || '',
            })),
        }))

        this.torrents[torrent.infoHash] = torrent

        setTimeout(() => {
            this.checkForExpiredTorrents().catch((err) => {
                this.config.logger.error(err)
            })
        }, 1000)

        return torrent
    }

    protected async checkForExpiredTorrents(): Promise<void> {
        if (this.cleanLocked) {
            return
        }
        this.cleanLocked = true
        try {
            const torrentToRemove = Object.values(this.torrents).filter(
                (torrent) =>
                    Date.now() - torrent.updated.getTime() > this.config.autocleanInternal * 1000
            )
            for (const torrent of torrentToRemove) {
                this.config.logger.info(`Removing expired ${torrent.name} torrent`)
                await this.removeTorrent(torrent.infoHash)
            }
        } finally {
            this.cleanLocked = false
        }
    }
}

