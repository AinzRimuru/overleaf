import { callbackify } from 'node:util'
import logger from '@overleaf/logger'
import { Project } from '../../models/Project.mjs'
import WebDAVProjectHandler from './WebDAVProjectHandler.mjs'
import WebDAVSyncService from './WebDAVSyncService.mjs'

/**
 * Service for WebDAV backup functionality
 * 
 * Backup logic:
 * 1. When a file modification triggers WebDAV sync, checkAndTriggerBackup is called
 * 2. If current time < nextCheckTime, skip (don't count this modification)
 * 3. If current time >= nextCheckTime, increment modificationCount and update nextCheckTime
 * 4. If modificationCount >= modificationThreshold, create a backup and reset counter
 * 5. After creating backup, cleanup old backups if exceeding maxBackups
 */

/**
 * Check if a backup should be triggered and create it if conditions are met
 * Called after each successful WebDAV sync operation
 */
async function checkAndTriggerBackup(projectId) {
    try {
        const project = await Project.findById(projectId, {
            'webdav.enabled': 1,
            'webdav.backup': 1,
            'webdav.basePath': 1,
        }).exec()

        // Skip if WebDAV or backup is not enabled
        if (!project?.webdav?.enabled || !project?.webdav?.backup?.enabled) {
            return { triggered: false, reason: 'backup_not_enabled' }
        }

        const backup = project.webdav.backup
        const now = new Date()

        // Check if we've reached the check time
        if (backup.nextCheckTime && now < backup.nextCheckTime) {
            // Not yet time to count this modification
            return { triggered: false, reason: 'not_check_time' }
        }

        // Increment modification count and update next check time
        const intervalMs = (backup.intervalMinutes || 10) * 60 * 1000
        const nextCheckTime = new Date(now.getTime() + intervalMs)
        const newCount = (backup.modificationCount || 0) + 1
        const threshold = backup.modificationThreshold || 6

        logger.debug(
            { projectId, newCount, threshold, nextCheckTime },
            'WebDAV backup: incrementing modification count'
        )

        // Check if we should trigger a backup
        if (newCount >= threshold) {
            // Time to create a backup
            logger.info({ projectId, newCount, threshold }, 'WebDAV backup: triggering backup')

            // Reset counter and update timestamps
            await Project.updateOne(
                { _id: projectId },
                {
                    $set: {
                        'webdav.backup.modificationCount': 0,
                        'webdav.backup.nextCheckTime': nextCheckTime,
                    },
                }
            ).exec()

            // Create the backup
            const backupResult = await createBackup(projectId)

            // Cleanup old backups
            await cleanupOldBackups(projectId)

            return { triggered: true, backupResult }
        } else {
            // Just update the counter
            await Project.updateOne(
                { _id: projectId },
                {
                    $set: {
                        'webdav.backup.modificationCount': newCount,
                        'webdav.backup.nextCheckTime': nextCheckTime,
                    },
                }
            ).exec()

            return { triggered: false, reason: 'threshold_not_reached', count: newCount }
        }
    } catch (err) {
        logger.error({ err, projectId }, 'WebDAV backup: failed to check/trigger backup')
        return { triggered: false, reason: 'error', error: err.message }
    }
}

/**
 * Create a backup of the project to WebDAV
 * Backs up to {basePath}/backups/{timestamp}/
 */
async function createBackup(projectId) {
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        throw new Error('Project not linked to WebDAV')
    }

    try {
        const project = await Project.findById(projectId, {
            name: 1,
            rootFolder: 1,
            'webdav.basePath': 1,
        }).exec()

        // Create backup directory with timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const backupPath = `${webdavClient.basePath}/backups/${timestamp}`

        logger.info({ projectId, backupPath }, 'WebDAV backup: creating backup')

        // Ensure backup directory exists
        const backupsDir = `${webdavClient.basePath}/backups`
        const backupsDirExists = await webdavClient.client.exists(backupsDir)
        if (!backupsDirExists) {
            await webdavClient.client.createDirectory(backupsDir, { recursive: true })
        }

        await webdavClient.client.createDirectory(backupPath, { recursive: true })

        // Collect all docs and files
        const allDocs = []
        const allFiles = []

        function collectEntities(folder, currentPath = '') {
            if (folder.docs) {
                for (const doc of folder.docs) {
                    const docPath = currentPath ? `${currentPath}/${doc.name}` : doc.name
                    allDocs.push({ doc, path: docPath })
                }
            }

            if (folder.fileRefs) {
                for (const file of folder.fileRefs) {
                    const filePath = currentPath ? `${currentPath}/${file.name}` : file.name
                    if (file.hash) {
                        allFiles.push({ file, path: filePath })
                    }
                }
            }

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

        // Import required modules
        const DocstoreManager = (await import('../Docstore/DocstoreManager.mjs')).default
        const HistoryManager = (await import('../History/HistoryManager.mjs')).default
        const { promiseMapWithLimit } = await import('@overleaf/promise-utils')

        // Backup documents
        await promiseMapWithLimit(5, allDocs, async ({ doc, path }) => {
            try {
                const { lines } = await DocstoreManager.promises.getDoc(projectId, doc._id)
                const content = lines.join('\n')
                const remotePath = `${backupPath}/${path}`
                const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'))

                if (parentDir && parentDir !== backupPath) {
                    const exists = await webdavClient.client.exists(parentDir)
                    if (!exists) {
                        await webdavClient.client.createDirectory(parentDir, { recursive: true })
                    }
                }

                await webdavClient.client.putFileContents(remotePath, content, {
                    overwrite: true,
                })
            } catch (err) {
                logger.warn({ err, projectId, docPath: path }, 'WebDAV backup: failed to backup doc')
            }
        })

        // Backup files
        await promiseMapWithLimit(5, allFiles, async ({ file, path }) => {
            try {
                const { stream } = await HistoryManager.promises.requestBlobWithProjectId(
                    projectId,
                    file.hash,
                    'GET'
                )

                const chunks = []
                for await (const chunk of stream) {
                    chunks.push(chunk)
                }
                const buffer = Buffer.concat(chunks)

                const remotePath = `${backupPath}/${path}`
                const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'))

                if (parentDir && parentDir !== backupPath) {
                    const exists = await webdavClient.client.exists(parentDir)
                    if (!exists) {
                        await webdavClient.client.createDirectory(parentDir, { recursive: true })
                    }
                }

                await webdavClient.client.putFileContents(remotePath, buffer, {
                    overwrite: true,
                })
            } catch (err) {
                logger.warn({ err, projectId, filePath: path }, 'WebDAV backup: failed to backup file')
            }
        })

        // Update last backup time
        await Project.updateOne(
            { _id: projectId },
            {
                $set: {
                    'webdav.backup.lastBackupAt': new Date(),
                },
            }
        ).exec()

        logger.info(
            { projectId, backupPath, docCount: allDocs.length, fileCount: allFiles.length },
            'WebDAV backup: backup created successfully'
        )

        return {
            success: true,
            backupPath,
            docCount: allDocs.length,
            fileCount: allFiles.length,
        }
    } catch (err) {
        logger.error({ err, projectId }, 'WebDAV backup: failed to create backup')
        throw err
    }
}

/**
 * List all backups on WebDAV for a project
 */
async function listBackups(projectId) {
    const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)

    if (!webdavClient) {
        throw new Error('Project not linked to WebDAV')
    }

    try {
        const backupsDir = `${webdavClient.basePath}/backups`
        const exists = await webdavClient.client.exists(backupsDir)

        if (!exists) {
            return []
        }

        const contents = await webdavClient.client.getDirectoryContents(backupsDir)

        // Filter only directories and sort by name (timestamp) descending
        const backups = contents
            .filter(item => item.type === 'directory')
            .map(item => ({
                name: item.basename,
                path: item.filename,
                createdAt: item.lastmod,
            }))
            .sort((a, b) => b.name.localeCompare(a.name))

        return backups
    } catch (err) {
        logger.error({ err, projectId }, 'WebDAV backup: failed to list backups')
        throw err
    }
}

/**
 * Cleanup old backups exceeding the maximum count
 */
async function cleanupOldBackups(projectId) {
    try {
        const project = await Project.findById(projectId, {
            'webdav.backup.maxBackups': 1,
        }).exec()

        const maxBackups = project?.webdav?.backup?.maxBackups || 10
        const backups = await listBackups(projectId)

        if (backups.length <= maxBackups) {
            return { deleted: 0 }
        }

        const webdavClient = await WebDAVProjectHandler.promises.getWebDAVClient(projectId)
        if (!webdavClient) {
            return { deleted: 0 }
        }

        // Delete oldest backups (they're sorted newest first)
        const backupsToDelete = backups.slice(maxBackups)
        let deleted = 0

        for (const backup of backupsToDelete) {
            try {
                await webdavClient.client.deleteFile(backup.path)
                deleted++
                logger.debug({ projectId, backupPath: backup.path }, 'WebDAV backup: deleted old backup')
            } catch (err) {
                logger.warn({ err, projectId, backupPath: backup.path }, 'WebDAV backup: failed to delete old backup')
            }
        }

        logger.info({ projectId, deleted, total: backups.length }, 'WebDAV backup: cleaned up old backups')
        return { deleted }
    } catch (err) {
        logger.error({ err, projectId }, 'WebDAV backup: failed to cleanup old backups')
        return { deleted: 0, error: err.message }
    }
}

export default {
    checkAndTriggerBackup: callbackify(checkAndTriggerBackup),
    createBackup: callbackify(createBackup),
    listBackups: callbackify(listBackups),
    cleanupOldBackups: callbackify(cleanupOldBackups),
    promises: {
        checkAndTriggerBackup,
        createBackup,
        listBackups,
        cleanupOldBackups,
    },
}
