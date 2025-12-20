import { Project } from '../../models/Project.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.js'
import FileStoreHandler from '../FileStore/FileStoreHandler.mjs'
import ProjectEntityHandler from './ProjectEntityHandler.mjs'
import ProjectGetter from './ProjectGetter.mjs'
import Logger from '@overleaf/logger'

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
            })

            if (!project) {
                Logger.warn({ projectId }, 'Project not found for WebDAV sync')
                return
            }

            const { docs, files } = ProjectEntityHandler.getAllEntitiesFromProject(project)
            const client = await this.createClient(config)
            const basePath = config.basePath || '/overleaf'

            // Sync all documents
            for (const { path: docPath, doc } of docs) {
                try {
                    const docData = await DocstoreManager.promises.getDoc(
                        projectId.toString(),
                        doc._id.toString()
                    )
                    const content = docData.lines.join('\n')

                    const remotePath = `${basePath}${docPath}`
                    const parentDir = docPath.substring(0, docPath.lastIndexOf('/'))
                    if (parentDir) {
                        await this.ensureDirectoryExists(client, parentDir, basePath)
                    }

                    await client.putFileContents(remotePath, content)
                    Logger.info({ projectId, docPath }, 'Document synced to WebDAV')
                } catch (err) {
                    Logger.warn({ err, projectId, docPath: docPath }, 'Failed to sync document')
                }
            }

            // Sync all files
            for (const { path: filePath, file } of files) {
                try {
                    const fileStream = await FileStoreHandler.promises.getFileStream(
                        projectId.toString(),
                        file._id.toString()
                    )

                    // Read stream into buffer
                    const chunks = []
                    for await (const chunk of fileStream) {
                        chunks.push(chunk)
                    }
                    const buffer = Buffer.concat(chunks)

                    const remotePath = `${basePath}${filePath}`
                    const parentDir = filePath.substring(0, filePath.lastIndexOf('/'))
                    if (parentDir) {
                        await this.ensureDirectoryExists(client, parentDir, basePath)
                    }

                    await client.putFileContents(remotePath, buffer)
                    Logger.info({ projectId, filePath }, 'File synced to WebDAV')
                } catch (err) {
                    Logger.warn({ err, projectId, filePath: filePath }, 'Failed to sync file')
                }
            }

            // Update last sync date
            await Project.updateOne(
                { _id: projectId },
                { $set: { 'webdavConfig.lastSyncDate': new Date() } }
            ).exec()

            Logger.info({ projectId, docsCount: docs.length, filesCount: files.length },
                'Full project sync to WebDAV completed')
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
        } catch (err) {
            Logger.warn({ err, projectId, oldPath, newPath }, 'Failed to move file on WebDAV')
        }
    },
}

export default ProjectWebDAVSync
