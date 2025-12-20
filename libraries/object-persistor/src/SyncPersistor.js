const AbstractPersistor = require('./AbstractPersistor')
const PersistorHelper = require('./PersistorHelper')
const { WriteError } = require('./Errors')
const Logger = require('@overleaf/logger')

console.error(' [SyncPersistor] Module Loaded')

module.exports = class SyncPersistor extends AbstractPersistor {
    constructor(primaryPersistor, configProvider) {
        super()
        this.primary = primaryPersistor
        this.configProvider = configProvider
        this.webdavPersistors = new Map() // Cache persistors by projectId
    }

    async getSyncPersistor(location, name) {
        console.error(` [SyncPersistor] getSyncPersistor location=${location} name=${name}`)
        let projectId = location


        // In filestore, location is the bucket name (e.g. 'filestore').
        // The projectId is part of the key (name), e.g. 'projectId/fileId'.
        const isObjectId = key => /^[0-9a-f]{24}$/i.test(key)

        if (!isObjectId(location) && name) {
            const parts = name.split('/')
            if (parts.length > 0 && isObjectId(parts[0])) {
                projectId = parts[0]
            }
        }

        if (!isObjectId(projectId)) {
            // If we can't determine the project ID, we can't sync.
            return null
        }

        if (this.webdavPersistors.has(projectId)) {
            return this.webdavPersistors.get(projectId)
        }

        try {
            Logger.info({ location, projectId, name }, 'checking webdav config for project')
            const config = await this.configProvider.getWebDAVConfig(projectId)
            Logger.info({ location, projectId, config }, 'got webdav config')
            if (config && config.url && config.enabled) {
                const WebDAVPersistor = require('./WebDAVPersistor')
                const persistor = new WebDAVPersistor(config)
                this.webdavPersistors.set(projectId, persistor)
                Logger.info({ projectId }, 'initialized WebDAV persistor')
                return persistor
            }
        } catch (err) {
            Logger.warn({ err, location, projectId }, 'failed to get project webdav config')
        }
        return null
    }

    async sendFile(location, target, source) {
        console.error(` [SyncPersistor] sendFile called location=${location} target=${target}`)
        Logger.info({ location, target, source }, 'sendFile called')
        await this.primary.sendFile(location, target, source)
        this._syncToRemote(location, target).catch(err => {
            Logger.warn({ err, location, target }, 'background sync to remote failed')
        })
    }

    async sendStream(location, target, sourceStream, opts = {}) {
        console.error(` [SyncPersistor] sendStream called location=${location} target=${target}`)
        Logger.info({ location, target, opts }, 'sendStream called')
        await this.primary.sendStream(location, target, sourceStream, opts)
        this._syncToRemote(location, target).catch(err => {
            Logger.warn({ err, location, target }, 'background sync to remote failed')
        })
    }

    async getObjectStream(location, name, opts = {}) {
        try {
            await this.syncFile(location, name)
        } catch (err) {
            Logger.warn({ err, location, name }, 'sync on read failed')
        }
        return this.primary.getObjectStream(location, name, opts)
    }

    async getRedirectUrl(location, name) {
        return this.primary.getRedirectUrl(location, name)
    }

    async getObjectSize(location, name, opts) {
        return this.primary.getObjectSize(location, name, opts)
    }

    async getObjectMd5Hash(location, name, opts) {
        return this.primary.getObjectMd5Hash(location, name, opts)
    }

    async copyObject(location, fromName, toName, opts) {
        await this.primary.copyObject(location, fromName, toName, opts)
        this._syncToRemote(location, toName).catch(err => {
            Logger.warn(
                { err, location, fromName, toName },
                'background sync to remote failed'
            )
        })
    }

    async deleteObject(location, name) {
        await this.primary.deleteObject(location, name)
        try {
            const sync = await this.getSyncPersistor(location, name)
            if (sync) {
                await sync.deleteObject(location, name)
            }
        } catch (err) {
            Logger.warn({ err, location, name }, 'background delete from sync failed')
        }
    }

    async deleteDirectory(location, name, continuationToken) {
        await this.primary.deleteDirectory(location, name, continuationToken)
        try {
            const sync = await this.getSyncPersistor(location, name)
            if (sync) {
                await sync.deleteDirectory(location, name, continuationToken)
            }
        } catch (err) {
            Logger.warn({ err, location, name }, 'background delete from sync failed')
        }
    }

    async checkIfObjectExists(location, name, opts) {
        return this.primary.checkIfObjectExists(location, name, opts)
    }

    async directorySize(location, name, continuationToken) {
        return this.primary.directorySize(location, name, continuationToken)
    }

    async listDirectoryKeys(location, prefix) {
        return this.primary.listDirectoryKeys(location, prefix)
    }

    async listDirectoryStats(location, prefix) {
        return this.primary.listDirectoryStats(location, prefix)
    }

    async getObjectMetadata(location, name) {
        try {
            await this.syncFile(location, name)
        } catch (err) {
            Logger.warn({ err, location, name }, 'sync on metadata read failed')
        }
        return this.primary.getObjectMetadata(location, name)
    }

    async syncFile(location, name) {
        Logger.info({ location, name }, 'syncFile called')
        const sync = await this.getSyncPersistor(location, name)
        if (!sync) return

        let primaryMeta, syncMeta

        try {
            primaryMeta = await this.primary.getObjectMetadata(location, name)
        } catch (err) {
            // Treat as missing
        }

        try {
            syncMeta = await sync.getObjectMetadata(location, name)
        } catch (err) {
            // Treat as missing
        }

        Logger.info({ location, name, primaryMeta, syncMeta }, 'syncFile metadata comparison')

        if (!primaryMeta && !syncMeta) {
            return // Both missing
        }

        if (primaryMeta && !syncMeta) {
            // Local exists, remote missing -> Push
            Logger.info({ location, name }, 'Pushing to remote (remote missing)')
            await this._syncToRemote(location, name)
            return
        }

        if (!primaryMeta && syncMeta) {
            // Remote exists, local missing -> Pull
            Logger.info({ location, name }, 'Pulling from remote (local missing)')
            await this._syncToLocal(location, name)
            return
        }

        // Both exist, check timestamps
        const primaryTime = primaryMeta.lastModified.getTime()
        const syncTime = syncMeta.lastModified.getTime()

        if (syncTime > primaryTime) {
            // Remote newer -> Pull
            Logger.info({ location, name, syncTime, primaryTime }, 'Pulling from remote (newer)')
            await this._syncToLocal(location, name)
        } else if (syncTime < primaryTime) {
            // Remote older -> Push
            Logger.info({ location, name, syncTime, primaryTime }, 'Pushing to remote (newer)')
            await this._syncToRemote(location, name)
        }
        // Else equal -> No-op
    }

    async _syncToRemote(location, name) {
        Logger.info({ location, name }, '_syncToRemote called')
        const sync = await this.getSyncPersistor(location, name)
        if (!sync) return

        try {
            const stream = await this.primary.getObjectStream(location, name)
            await sync.sendStream(location, name, stream)
            Logger.info({ location, name }, '_syncToRemote success')
        } catch (err) {
            throw PersistorHelper.wrapError(
                err,
                'failed to sync to remote',
                { location, name },
                WriteError
            )
        }
    }

    async _syncToLocal(location, name) {
        Logger.info({ location, name }, '_syncToLocal called')
        const sync = await this.getSyncPersistor(location, name)
        if (!sync) return

        try {
            const stream = await sync.getObjectStream(location, name)
            await this.primary.sendStream(location, name, stream)
            Logger.info({ location, name }, '_syncToLocal success')
        } catch (err) {
            throw PersistorHelper.wrapError(
                err,
                'failed to sync to local',
                { location, name },
                WriteError
            )
        }
    }
}
