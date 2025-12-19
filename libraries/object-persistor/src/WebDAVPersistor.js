const AbstractPersistor = require('./AbstractPersistor')
const { createClient } = require('webdav')
const Stream = require('node:stream')
const { pipeline } = require('node:stream/promises')
const crypto = require('node:crypto')
const { NotFoundError, WriteError, ReadError } = require('./Errors')
const Logger = require('@overleaf/logger')

/**
 * WebDAV Persistor for storing files on WebDAV servers
 */
class WebDAVPersistor extends AbstractPersistor {
    constructor(settings) {
        super()
        this.settings = settings

        // Create WebDAV client instances per location (project)
        this.clients = new Map()
    }

    /**
     * Get or create a WebDAV client for a specific location
     * @param {string} location - The WebDAV server URL or project-specific config
     * @returns {Object} WebDAV client instance
     */
    _getClient(location) {
        // If location is a full config object (for project-specific WebDAV)
        if (typeof location === 'object' && location.url) {
            const key = `${location.url}:${location.username}`
            if (!this.clients.has(key)) {
                this.clients.set(key, createClient(location.url, {
                    username: location.username,
                    password: location.password,
                    timeout: this.settings.timeout || 30000,
                    maxContentLength: this.settings.maxContentLength || 100 * 1024 * 1024, // 100MB
                }))
            }
            return this.clients.get(key)
        }

        // Use default WebDAV server from settings
        if (!this.clients.has('default')) {
            this.clients.set('default', createClient(this.settings.url, {
                username: this.settings.username,
                password: this.settings.password,
                timeout: this.settings.timeout || 30000,
                maxContentLength: this.settings.maxContentLength || 100 * 1024 * 1024,
            }))
        }
        return this.clients.get('default')
    }

    /**
     * Build the full WebDAV path
     * @param {string|Object} location - Base path or config object
     * @param {string} key - File key/path
     * @returns {string} Full WebDAV path
     */
    _buildPath(location, key) {
        const basePath = typeof location === 'object' ? location.basePath : location
        return `${basePath}/${key}`.replace(/\/+/g, '/')
    }

    /**
     * Upload a file from local filesystem to WebDAV
     */
    async sendFile(location, target, source) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, target)

        try {
            const fs = require('node:fs')
            const readStream = fs.createReadStream(source)
            await this.sendStream(location, target, readStream)
        } catch (err) {
            throw new WriteError('failed to upload file to WebDAV', { location, target, source }, err)
        }
    }

    /**
     * Upload a stream to WebDAV
     */
    async sendStream(location, target, sourceStream, opts = {}) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, target)

        try {
            // Ensure parent directory exists
            const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'))
            if (parentDir) {
                await this._ensureDirectoryExists(client, parentDir)
            }

            // Create a buffer to collect stream data
            const chunks = []
            const bufferStream = new Stream.Writable({
                write(chunk, encoding, callback) {
                    chunks.push(chunk)
                    callback()
                }
            })

            await pipeline(sourceStream, bufferStream)
            const buffer = Buffer.concat(chunks)

            // Upload to WebDAV
            await client.putFileContents(remotePath, buffer, {
                contentLength: buffer.length,
                overwrite: true,
                contentType: opts.contentType,
            })

            Logger.debug({ location, target, size: buffer.length }, 'uploaded file to WebDAV')
        } catch (err) {
            throw new WriteError('failed to upload stream to WebDAV', { location, target }, err)
        }
    }

    /**
     * Get a readable stream from WebDAV
     */
    async getObjectStream(location, name, opts = {}) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            const exists = await client.exists(remotePath)
            if (!exists) {
                throw new NotFoundError('file not found on WebDAV server', { location, name })
            }

            const buffer = await client.getFileContents(remotePath, {
                format: 'binary'
            })

            // Handle byte range requests
            let data = buffer
            if (opts.start !== undefined || opts.end !== undefined) {
                const start = opts.start || 0
                const end = opts.end !== undefined ? opts.end + 1 : buffer.length
                data = buffer.slice(start, end)
            }

            // Convert buffer to readable stream
            const stream = Stream.Readable.from(data)
            return stream
        } catch (err) {
            if (err instanceof NotFoundError) {
                throw err
            }
            throw new ReadError('failed to read file from WebDAV', { location, name }, err)
        }
    }

    /**
     * Get a redirect URL (not supported for WebDAV)
     */
    async getRedirectUrl(location, name) {
        // WebDAV doesn't support signed URLs, return null to fall back to streaming
        return null
    }

    /**
     * Get the size of an object
     */
    async getObjectSize(location, name) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            const stat = await client.stat(remotePath)
            return stat.size
        } catch (err) {
            throw new NotFoundError('file not found on WebDAV server', { location, name }, err)
        }
    }

    /**
     * Get MD5 hash of an object
     */
    async getObjectMd5Hash(location, name) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            const buffer = await client.getFileContents(remotePath, { format: 'binary' })
            const hash = crypto.createHash('md5').update(buffer).digest('hex')
            return hash
        } catch (err) {
            throw new NotFoundError('file not found on WebDAV server', { location, name }, err)
        }
    }

    /**
     * Copy an object within the same WebDAV server
     */
    async copyObject(location, fromName, toName) {
        const client = this._getClient(location)
        const fromPath = this._buildPath(location, fromName)
        const toPath = this._buildPath(location, toName)

        try {
            // Ensure destination directory exists
            const parentDir = toPath.substring(0, toPath.lastIndexOf('/'))
            if (parentDir) {
                await this._ensureDirectoryExists(client, parentDir)
            }

            await client.copyFile(fromPath, toPath)
        } catch (err) {
            throw new WriteError('failed to copy file on WebDAV', { location, fromName, toName }, err)
        }
    }

    /**
     * Delete an object
     */
    async deleteObject(location, name) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            const exists = await client.exists(remotePath)
            if (exists) {
                await client.deleteFile(remotePath)
                Logger.debug({ location, name }, 'deleted file from WebDAV')
            }
        } catch (err) {
            Logger.warn({ err, location, name }, 'failed to delete file from WebDAV')
            // Don't throw error for delete operations
        }
    }

    /**
     * Delete a directory and all its contents
     */
    async deleteDirectory(location, name) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            const exists = await client.exists(remotePath)
            if (exists) {
                await client.deleteFile(remotePath)
                Logger.debug({ location, name }, 'deleted directory from WebDAV')
            }
        } catch (err) {
            Logger.warn({ err, location, name }, 'failed to delete directory from WebDAV')
        }
    }

    /**
     * Check if an object exists
     */
    async checkIfObjectExists(location, name) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            return await client.exists(remotePath)
        } catch (err) {
            return false
        }
    }

    /**
     * Get the total size of a directory
     */
    async directorySize(location, name) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, name)

        try {
            const items = await client.getDirectoryContents(remotePath, { deep: true })
            let totalSize = 0

            for (const item of items) {
                if (item.type === 'file') {
                    totalSize += item.size
                }
            }

            return totalSize
        } catch (err) {
            Logger.warn({ err, location, name }, 'failed to calculate directory size')
            return 0
        }
    }

    /**
     * List all keys in a directory
     */
    async listDirectoryKeys(location, prefix) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, prefix)

        try {
            const items = await client.getDirectoryContents(remotePath, { deep: true })
            return items
                .filter(item => item.type === 'file')
                .map(item => item.filename.replace(remotePath, '').replace(/^\//, ''))
        } catch (err) {
            Logger.warn({ err, location, prefix }, 'failed to list directory keys')
            return []
        }
    }

    /**
     * List directory contents with stats
     */
    async listDirectoryStats(location, prefix) {
        const client = this._getClient(location)
        const remotePath = this._buildPath(location, prefix)

        try {
            const items = await client.getDirectoryContents(remotePath, { deep: true })
            return items
                .filter(item => item.type === 'file')
                .map(item => ({
                    key: item.filename.replace(remotePath, '').replace(/^\//, ''),
                    size: item.size
                }))
        } catch (err) {
            Logger.warn({ err, location, prefix }, 'failed to list directory stats')
            return []
        }
    }

    /**
     * Ensure a directory exists, creating it if necessary
     * @private
     */
    async _ensureDirectoryExists(client, dirPath) {
        try {
            const exists = await client.exists(dirPath)
            if (!exists) {
                await client.createDirectory(dirPath, { recursive: true })
            }
        } catch (err) {
            Logger.warn({ err, dirPath }, 'failed to ensure directory exists')
        }
    }
}

module.exports = WebDAVPersistor
