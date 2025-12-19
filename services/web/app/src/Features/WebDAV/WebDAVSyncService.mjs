import { callbackify } from 'node:util'
import logger from '@overleaf/logger'
import { Project } from '../../models/Project.mjs'
import WebDAVProjectHandler from './WebDAVProjectHandler.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import { promiseMapWithLimit } from '@overleaf/promise-utils'

/**
 * Service for syncing project files to WebDAV
 */

/**
 * Sync a document to WebDAV
 */
async function syncDocument(projectId, docId, docPath) {
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        // Project not linked to WebDAV, skip sync
        return
    }

    try {
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        // Get document content from docstore
        const { lines } = await DocstoreManager.promises.getDoc(projectId, docId)
        const content = lines.join('\n')

        // Upload to WebDAV
        const remotePath = `${webdavClient.basePath}/${docPath}`
        const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'))

        // Ensure parent directory exists
        if (parentDir && parentDir !== webdavClient.basePath) {
            const exists = await webdavClient.client.exists(parentDir)
            if (!exists) {
                await webdavClient.client.createDirectory(parentDir, { recursive: true })
            }
        }

        await webdavClient.client.putFileContents(remotePath, content, {
            overwrite: true,
        })

        logger.debug({ projectId, docId, remotePath }, 'synced document to WebDAV')

        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })
    } catch (err) {
        logger.error({ err, projectId, docId }, 'failed to sync document to WebDAV')
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
    }
}

/**
 * Sync a file to WebDAV using its hash from History service
 */
async function syncFile(projectId, fileId, filePath, fileHash) {
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        return
    }

    try {
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        // Get file stream from history service using hash
        const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
            projectId,
            fileHash,
            'GET'
        )

        // Collect stream data
        const chunks = []
        for await (const chunk of stream) {
            chunks.push(chunk)
        }
        const buffer = Buffer.concat(chunks)

        // Upload to WebDAV
        const remotePath = `${webdavClient.basePath}/${filePath}`
        const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'))

        if (parentDir && parentDir !== webdavClient.basePath) {
            const exists = await webdavClient.client.exists(parentDir)
            if (!exists) {
                await webdavClient.client.createDirectory(parentDir, { recursive: true })
            }
        }

        await webdavClient.client.putFileContents(remotePath, buffer, {
            overwrite: true,
        })

        logger.debug({ projectId, fileId, remotePath }, 'synced file to WebDAV')

        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })
    } catch (err) {
        logger.error({ err, projectId, fileId, fileHash }, 'failed to sync file to WebDAV')
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
    }
}

/**
 * Delete a file from WebDAV
 */
async function deleteFromWebDAV(projectId, entityPath) {
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        return
    }

    try {
        const remotePath = `${webdavClient.basePath}/${entityPath}`
        const exists = await webdavClient.client.exists(remotePath)

        if (exists) {
            await webdavClient.client.deleteFile(remotePath)
            logger.debug({ projectId, remotePath }, 'deleted file from WebDAV')
        }
    } catch (err) {
        logger.error({ err, projectId, entityPath }, 'failed to delete file from WebDAV')
    }
}

/**
 * Sync entire project to WebDAV
 */
async function syncProject(projectId) {
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        throw new Error('Project not linked to WebDAV')
    }

    try {
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        const project = await Project.findById(projectId, {
            name: 1,
            rootFolder: 1,
        }).exec()

        // Ensure base directory exists
        const exists = await webdavClient.client.exists(webdavClient.basePath)
        if (!exists) {
            await webdavClient.client.createDirectory(webdavClient.basePath, {
                recursive: true,
            })
        }

        // Sync all documents and files
        const allDocs = []
        const allFiles = []

        function collectEntities(folder, currentPath = '') {
            // Collect docs
            if (folder.docs) {
                for (const doc of folder.docs) {
                    const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name
                    allDocs.push({ doc, path: docPath })
                }
            }

            // Collect files (PNG, images, PDFs, etc.)
            if (folder.fileRefs) {
                for (const file of folder.fileRefs) {
                    const filePath = currentPath ? `${currentPath}/${file.name}` : file.name
                    // Only sync files with a hash
                    if (file.hash) {
                        allFiles.push({ file, path: filePath })
                    }
                }
            }

            // Recurse into subfolders
            if (folder.folders) {
                for (const subfolder of folder.folders) {
                    const subPath = currentPath
                        ? `${currentPath}/${subfolder.name}`
                        : subfolder.name
                    collectEntities(subfolder, subPath)
                }
            }
        }

        collectEntities(project.rootFolder[0])

        logger.info({ projectId, docCount: allDocs.length, fileCount: allFiles.length }, 'syncing project to WebDAV')

        // Sync documents
        await promiseMapWithLimit(5, allDocs, async ({ doc, path }) => {
            await syncDocument(projectId, doc._id, path)
        })

        // Sync files - pass the hash for each file
        await promiseMapWithLimit(5, allFiles, async ({ file, path }) => {
            await syncFile(projectId, file._id, path, file.hash)
        })

        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })

        logger.info({ projectId }, 'synced entire project to WebDAV')
        return { success: true, docCount: allDocs.length, fileCount: allFiles.length }
    } catch (err) {
        logger.error({ err, projectId }, 'failed to sync project to WebDAV')
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
        throw err
    }
}

/**
 * Sync compile outputs (PDF, etc.) to WebDAV
 * This function downloads output files from CLSI and uploads to WebDAV
 */
async function syncCompileOutputs(projectId, outputFiles, clsiServerId, buildId) {
    // Get WebDAV client - skip if not linked
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        return
    }

    // Filter output files to sync (typically just PDF)
    const filesToSync = outputFiles.filter(f =>
        f.path === 'output.pdf' || f.path.endsWith('.pdf')
    )

    if (filesToSync.length === 0) {
        return
    }

    // Import dependencies
    const { fetchStreamWithResponse } = await import('@overleaf/fetch-utils')
    const Settings = (await import('@overleaf/settings')).default

    try {
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        // Create output directory on WebDAV
        const outputDir = `${webdavClient.basePath}/output`
        const outputDirExists = await webdavClient.client.exists(outputDir)
        if (!outputDirExists) {
            await webdavClient.client.createDirectory(outputDir, { recursive: true })
        }

        for (const file of filesToSync) {
            try {
                // Build CLSI URL for the output file
                const clsiUrl = `${Settings.apis.clsi.url}/project/${projectId}/build/${buildId}/output/${file.path}`

                const { stream } = await fetchStreamWithResponse(clsiUrl, {
                    method: 'GET',
                    signal: AbortSignal.timeout(60 * 1000),
                })

                // Collect stream data
                const chunks = []
                for await (const chunk of stream) {
                    chunks.push(chunk)
                }
                const buffer = Buffer.concat(chunks)

                // Upload to WebDAV
                const remotePath = `${outputDir}/${file.path}`
                await webdavClient.client.putFileContents(remotePath, buffer, {
                    overwrite: true,
                })

                logger.debug({ projectId, file: file.path, remotePath }, 'synced compile output to WebDAV')
            } catch (err) {
                logger.warn({ err, projectId, file: file.path }, 'failed to sync compile output to WebDAV')
            }
        }

        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })

        logger.info({ projectId, fileCount: filesToSync.length }, 'synced compile outputs to WebDAV')
    } catch (err) {
        logger.error({ err, projectId }, 'failed to sync compile outputs to WebDAV')
        await WebDAVProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
    }
}

export default {
    syncDocument: callbackify(syncDocument),
    syncFile: callbackify(syncFile),
    deleteFromWebDAV: callbackify(deleteFromWebDAV),
    syncProject: callbackify(syncProject),
    syncCompileOutputs: callbackify(syncCompileOutputs),
    promises: {
        syncDocument,
        syncFile,
        deleteFromWebDAV,
        syncProject,
        syncCompileOutputs,
    },
}

