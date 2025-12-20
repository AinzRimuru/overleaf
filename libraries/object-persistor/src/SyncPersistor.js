const AbstractPersistor = require('./AbstractPersistor')
const PersistorHelper = require('./PersistorHelper')
const { WriteError } = require('./Errors')
const Logger = require('@overleaf/logger')

module.exports = class SyncPersistor extends AbstractPersistor {
    constructor(primaryPersistor, syncPersistor) {
        super()
        this.primary = primaryPersistor
        this.sync = syncPersistor
    }

    async sendFile(location, target, source) {
        await this.primary.sendFile(location, target, source)
        this._syncToRemote(location, target).catch(err => {
            Logger.warn({ err, location, target }, 'background sync to remote failed')
        })
    }

    async sendStream(location, target, sourceStream, opts = {}) {
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
        // For delete, we should also delete from sync
        try {
            await this.sync.deleteObject(location, name)
        } catch (err) {
            Logger.warn({ err, location, name }, 'background delete from sync failed')
        }
    }

    async deleteDirectory(location, name, continuationToken) {
        await this.primary.deleteDirectory(location, name, continuationToken)
        try {
            await this.sync.deleteDirectory(location, name, continuationToken)
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
        let primaryMeta, syncMeta

        try {
            primaryMeta = await this.primary.getObjectMetadata(location, name)
        } catch (err) {
            // Treat as missing
        }

        try {
            syncMeta = await this.sync.getObjectMetadata(location, name)
        } catch (err) {
            // Treat as missing
        }

        if (!primaryMeta && !syncMeta) {
            return // Both missing
        }

        if (primaryMeta && !syncMeta) {
            // Local exists, remote missing -> Push
            await this._syncToRemote(location, name)
            return
        }

        if (!primaryMeta && syncMeta) {
            // Remote exists, local missing -> Pull
            await this._syncToLocal(location, name)
            return
        }

        // Both exist, check timestamps
        const primaryTime = primaryMeta.lastModified.getTime()
        const syncTime = syncMeta.lastModified.getTime()

        if (syncTime > primaryTime) {
            // Remote newer -> Pull
            await this._syncToLocal(location, name)
        } else if (syncTime < primaryTime) {
            // Remote older -> Push
            await this._syncToRemote(location, name)
        }
        // Else equal -> No-op
    }

    async _syncToRemote(location, name) {
        try {
            const stream = await this.primary.getObjectStream(location, name)
            await this.sync.sendStream(location, name, stream)
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
        try {
            const stream = await this.sync.getObjectStream(location, name)
            await this.primary.sendStream(location, name, stream)
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
