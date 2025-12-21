import { Project } from '../../models/Project.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import ProjectEntityHandler from './ProjectEntityHandler.mjs'
import ProjectGetter from './ProjectGetter.mjs'
import Logger from '@overleaf/logger'
import crypto from 'crypto'

// Dynamic import for WebDAV client
let webdavModule = null
async function getWebDAVClient() {
    if (!webdavModule) {
        webdavModule = await import('webdav')
    }
    return webdavModule.createClient
}

/**
 * ProjectWebDAVSync - Syncs project files to WebDAV with user-friendly paths
 * 
 * This service syncs the actual project files (as seen in the editor) to WebDAV,
 * preserving the directory structure that users see.
 */
const ProjectWebDAVSync = {
    /**
     * Get WebDAV config for a project
     */
    async getWebDAVConfig(projectId) {
        const project = await Project.findById(projectId, { webdavConfig: 1 }).exec()
        if (!project || !project.webdavConfig || !project.webdavConfig.enabled) {
            return null
        }
        return project.webdavConfig
    },

    /**
     * Create a WebDAV client for the project
     */
    async createClient(config) {
        const createClient = await getWebDAVClient()
        return createClient(config.url, {
            username: config.username,
            password: config.password,
        })
    },

    /**
     * Get the modification time of a file on WebDAV
     * Returns null if the file doesn't exist
     */
    async getRemoteFileModTime(client, remotePath) {
        try {
            const exists = await client.exists(remotePath)
            console.error(`[WebDAV] getRemoteFileModTime: ${remotePath} exists=${exists}`)
            if (!exists) {
                return null
            }
            const stat = await client.stat(remotePath)
            console.error(`[WebDAV] getRemoteFileModTime: ${remotePath} stat=${JSON.stringify(stat)}`)
            if (stat && stat.lastmod) {
                const modTime = new Date(stat.lastmod)
                console.error(`[WebDAV] getRemoteFileModTime: ${remotePath} lastmod=${stat.lastmod} parsed=${modTime.toISOString()}`)
                return modTime
            }
            return null
        } catch (err) {
            // File doesn't exist or error getting stats
            console.error(`[WebDAV] getRemoteFileModTime error: ${remotePath} err=${err.message}`)
            Logger.debug({ err, remotePath }, 'Could not get remote file mod time')
            return null
        }
    },

    /**
     * Ensure directory exists on WebDAV
     */
    async ensureDirectoryExists(client, dirPath, basePath) {
        const fullPath = `${basePath}${dirPath}`
        const parts = fullPath.split('/').filter(p => p)
        let currentPath = ''

        for (const part of parts) {
            currentPath += '/' + part
            try {
                const exists = await client.exists(currentPath)
                if (!exists) {
                    await client.createDirectory(currentPath)
                }
            } catch (err) {
                // Directory might already exist
                if (!err.message?.includes('405')) {
                    Logger.warn({ err, path: currentPath }, 'Error creating directory')
                }
            }
        }
    },

    /**
     * Sync a single document to WebDAV
     */
    async syncDocument(projectId, docId, docPath, content) {
        try {
            const config = await this.getWebDAVConfig(projectId)
            if (!config) {
                return
            }

            const client = await this.createClient(config)
            const basePath = config.basePath || '/overleaf'
            const remotePath = `${basePath}${docPath}`

            // Ensure parent directory exists
            const parentDir = docPath.substring(0, docPath.lastIndexOf('/'))
            if (parentDir) {
                await this.ensureDirectoryExists(client, parentDir, basePath)
            }

            // Upload the document
            await client.putFileContents(remotePath, content)
            Logger.info({ projectId, docPath, remotePath }, 'Document synced to WebDAV')
        } catch (err) {
            Logger.warn({ err, projectId, docPath }, 'Failed to sync document to WebDAV')
        }
    },

    /**
     * Sync a single file (binary) to WebDAV
     */
    async syncFile(projectId, fileId, filePath, fileStream) {
        try {
            const config = await this.getWebDAVConfig(projectId)
            if (!config) {
                return
            }

            const client = await this.createClient(config)
            const basePath = config.basePath || '/overleaf'
            const remotePath = `${basePath}${filePath}`

            // Ensure parent directory exists
            const parentDir = filePath.substring(0, filePath.lastIndexOf('/'))
            if (parentDir) {
                await this.ensureDirectoryExists(client, parentDir, basePath)
            }

            // Upload the file
            await client.putFileContents(remotePath, fileStream)
            Logger.info({ projectId, filePath, remotePath }, 'File synced to WebDAV')
        } catch (err) {
            Logger.warn({ err, projectId, filePath }, 'Failed to sync file to WebDAV')
        }
    },

    /**
     * Sync all project files to WebDAV
     * This is useful for initial sync or full resync
     * 
     * Only syncs files if:
     * 1. The file doesn't exist on WebDAV
     * 2. The project has been modified (lastUpdated > lastSyncDate) AND 
     *    the WebDAV file was last synced before the project's lastUpdated time
     *    (i.e., remoteModTime < projectLastUpdated)
     * 
     * This ensures that only files that have potentially changed since the last 
     * sync are re-uploaded, rather than all files.
     */
    async syncAllProjectFiles(projectId) {
        try {
            const config = await this.getWebDAVConfig(projectId)
            if (!config) {
                Logger.info({ projectId }, 'No WebDAV config, skipping sync')
                return
            }

            Logger.info({ projectId }, 'Starting full project sync to WebDAV')

            const project = await ProjectGetter.promises.getProject(projectId, {
                rootFolder: true,
                name: true,
                lastUpdated: true,
            })

            if (!project) {
                Logger.warn({ projectId }, 'Project not found for WebDAV sync')
                return
            }

            // Get project's last updated time for comparison
            const projectLastUpdated = project.lastUpdated ? new Date(project.lastUpdated) : null
            const lastSyncDate = config.lastSyncDate ? new Date(config.lastSyncDate) : null

            // Get the stored file hashes from previous syncs
            // This is a Map of filePath -> fileHash
            const syncedFileHashes = config.syncedFileHashes instanceof Map
                ? new Map(config.syncedFileHashes)
                : new Map(Object.entries(config.syncedFileHashes || {}))

            console.error(`[WebDAV] Sync timing info:`)
            console.error(`[WebDAV]   projectLastUpdated: ${projectLastUpdated ? projectLastUpdated.toISOString() : 'null'}`)
            console.error(`[WebDAV]   lastSyncDate: ${lastSyncDate ? lastSyncDate.toISOString() : 'null'}`)
            console.error(`[WebDAV]   syncedFileHashes count: ${syncedFileHashes.size}`)

            Logger.debug({ projectId, projectLastUpdated, lastSyncDate, syncedFileHashesCount: syncedFileHashes.size },
                'Sync timing info')

            // If project hasn't been updated since last sync, skip entirely
            if (projectLastUpdated && lastSyncDate && projectLastUpdated <= lastSyncDate) {
                console.error(`[WebDAV] Project not modified since last sync, skipping entirely`)
                Logger.info({ projectId, projectLastUpdated, lastSyncDate },
                    'Project not modified since last sync, skipping')
                return
            }

            const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)
            const client = await this.createClient(config)
            const basePath = config.basePath || '/overleaf'

            // Record sync start time
            const syncStartTime = new Date()
            console.error(`[WebDAV]   syncStartTime: ${syncStartTime.toISOString()}`)

            // Ensure base path directory exists
            try {
                const exists = await client.exists(basePath)
                if (!exists) {
                    await client.createDirectory(basePath)
                    Logger.info({ projectId, basePath }, 'Created basePath directory on WebDAV')
                }
            } catch (err) {
                Logger.warn({ err, basePath }, 'Could not create basePath directory, continuing anyway')
            }

            let syncedDocsCount = 0
            let skippedDocsCount = 0
            let syncedFilesCount = 0
            let skippedFilesCount = 0

            // Track updated hashes for this sync
            const updatedHashes = new Map(syncedFileHashes)

            // Sync all documents
            for (const { path: docPath, doc } of docs) {
                try {
                    // Get document content first to compute hash
                    const docData = await DocstoreManager.promises.getDoc(
                        projectId.toString(),
                        doc._id.toString()
                    )
                    const content = docData.lines.join('\n')

                    // Compute hash of document content
                    const contentHash = crypto.createHash('md5').update(content).digest('hex')

                    // Check if hash has changed since last sync
                    const previousHash = syncedFileHashes.get(docPath)

                    console.error(`[WebDAV] Comparing doc ${docPath}:`)
                    console.error(`[WebDAV]   currentHash: ${contentHash}`)
                    console.error(`[WebDAV]   previousHash: ${previousHash || 'null'}`)

                    if (previousHash && previousHash === contentHash) {
                        console.error(`[WebDAV]   -> SKIPPING (hash unchanged)`)
                        Logger.debug({ projectId, docPath, contentHash },
                            'Skipping document sync - hash unchanged')
                        skippedDocsCount++
                        continue
                    }
                    console.error(`[WebDAV]   -> SYNCING (hash changed or new file)`)

                    const remotePath = `${basePath}${docPath}`
                    const parentDir = docPath.substring(0, docPath.lastIndexOf('/'))
                    if (parentDir) {
                        await this.ensureDirectoryExists(client, parentDir, basePath)
                    }

                    await client.putFileContents(remotePath, content, { overwrite: true })
                    Logger.info({ projectId, docPath }, 'Document synced to WebDAV')

                    // Update the hash in our tracking map
                    updatedHashes.set(docPath, contentHash)
                    syncedDocsCount++
                } catch (err) {
                    Logger.warn({ err, projectId, docPath: docPath }, 'Failed to sync document')
                }
            }

            // Sync all files
            for (const { path: filePath, file } of files) {
                try {
                    // Use file.hash directly - this is already available
                    if (!file.hash) {
                        Logger.warn({ projectId, filePath, fileId: file._id }, 'File missing hash, skipping')
                        continue
                    }

                    const currentHash = file.hash

                    // Check if hash has changed since last sync
                    const previousHash = syncedFileHashes.get(filePath)

                    console.error(`[WebDAV] Comparing file ${filePath}:`)
                    console.error(`[WebDAV]   currentHash: ${currentHash}`)
                    console.error(`[WebDAV]   previousHash: ${previousHash || 'null'}`)

                    if (previousHash && previousHash === currentHash) {
                        console.error(`[WebDAV]   -> SKIPPING (hash unchanged)`)
                        Logger.debug({ projectId, filePath, currentHash },
                            'Skipping file sync - hash unchanged')
                        skippedFilesCount++
                        continue
                    }
                    console.error(`[WebDAV]   -> SYNCING (hash changed or new file)`)

                    const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
                        projectId.toString(),
                        file.hash
                    )

                    // Read stream into buffer
                    const chunks = []
                    for await (const chunk of stream) {
                        chunks.push(chunk)
                    }
                    const buffer = Buffer.concat(chunks)

                    const remotePath = `${basePath}${filePath}`
                    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'))
                    if (parentDir) {
                        await this.ensureDirectoryExists(client, parentDir, basePath)
                    }

                    await client.putFileContents(remotePath, buffer, { overwrite: true })
                    Logger.info({ projectId, filePath }, 'File synced to WebDAV')

                    // Update the hash in our tracking map
                    updatedHashes.set(filePath, currentHash)
                    syncedFilesCount++
                } catch (err) {
                    Logger.warn({ err, projectId, filePath: filePath }, 'Failed to sync file')
                }
            }

            // Convert Map to object for MongoDB storage
            const hashesObject = Object.fromEntries(updatedHashes)

            // Update last sync date and synced file hashes
            await Project.updateOne(
                { _id: projectId },
                {
                    $set: {
                        'webdavConfig.lastSyncDate': syncStartTime,
                        'webdavConfig.syncedFileHashes': hashesObject
                    }
                }
            ).exec()
            console.error(`[WebDAV] Updated lastSyncDate to syncStartTime: ${syncStartTime.toISOString()}`)
            console.error(`[WebDAV] Updated syncedFileHashes: ${updatedHashes.size} entries`)

            Logger.info({
                projectId,
                syncedDocsCount,
                skippedDocsCount,
                syncedFilesCount,
                skippedFilesCount,
                totalDocs: docs.length,
                totalFiles: files.length
            }, 'Full project sync to WebDAV completed')
        } catch (err) {
            Logger.error({ err, projectId }, 'Failed to sync project to WebDAV')
            throw err
        }
    },

    /**
     * Delete a file/document from WebDAV
     */
    async deleteFromWebDAV(projectId, filePath) {
        try {
            const config = await this.getWebDAVConfig(projectId)
            if (!config) {
                return
            }

            const client = await this.createClient(config)
            const basePath = config.basePath || '/overleaf'
            const remotePath = `${basePath}${filePath}`

            try {
                await client.deleteFile(remotePath)
                Logger.info({ projectId, filePath, remotePath }, 'File deleted from WebDAV')
            } catch (err) {
                if (err.status !== 404) {
                    throw err
                }
                // File already doesn't exist, ignore
            }

            // Also remove the file hash from tracking
            await Project.updateOne(
                { _id: projectId },
                { $unset: { [`webdavConfig.syncedFileHashes.${filePath.replace(/\./g, '\\.')}`]: '' } }
            ).exec()
        } catch (err) {
            Logger.warn({ err, projectId, filePath }, 'Failed to delete file from WebDAV')
        }
    },

    /**
     * Rename/move a file on WebDAV
     */
    async moveOnWebDAV(projectId, oldPath, newPath) {
        try {
            const config = await this.getWebDAVConfig(projectId)
            if (!config) {
                return
            }

            const client = await this.createClient(config)
            const basePath = config.basePath || '/overleaf'
            const oldRemotePath = `${basePath}${oldPath}`
            const newRemotePath = `${basePath}${newPath}`

            // Ensure new parent directory exists
            const parentDir = newPath.substring(0, newPath.lastIndexOf('/'))
            if (parentDir) {
                await this.ensureDirectoryExists(client, parentDir, basePath)
            }

            try {
                await client.moveFile(oldRemotePath, newRemotePath)
                Logger.info({ projectId, oldPath, newPath }, 'File moved on WebDAV')
            } catch (err) {
                if (err.status === 404) {
                    // Source doesn't exist, ignore
                    Logger.warn({ projectId, oldPath }, 'Source file not found for move')
                } else {
                    throw err
                }
            }

            // Update the hash tracking: transfer hash from old path to new path
            const syncedFileHashes = config.syncedFileHashes instanceof Map
                ? config.syncedFileHashes
                : new Map(Object.entries(config.syncedFileHashes || {}))

            const hash = syncedFileHashes.get(oldPath)
            if (hash) {
                syncedFileHashes.delete(oldPath)
                syncedFileHashes.set(newPath, hash)

                const hashesObject = Object.fromEntries(syncedFileHashes)
                await Project.updateOne(
                    { _id: projectId },
                    { $set: { 'webdavConfig.syncedFileHashes': hashesObject } }
                ).exec()
            }
        } catch (err) {
            Logger.warn({ err, projectId, oldPath, newPath }, 'Failed to move file on WebDAV')
        }
    },
}

export default ProjectWebDAVSync
