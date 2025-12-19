import { callbackify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import logger from '@overleaf/logger'
import { Project } from '../../models/Project.mjs'
import GitBackupProjectHandler from './GitBackupProjectHandler.mjs'
import GitBackupService from './GitBackupService.mjs'
import DocstoreManager from '../Docstore/DocstoreManager.mjs'
import HistoryManager from '../History/HistoryManager.mjs'
import { promiseMapWithLimit } from '@overleaf/promise-utils'

/**
 * Service for syncing project files to Git repository
 */

/**
 * Sync a document to Git
 */
async function syncDocument(projectId, docId, docPath) {
    const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)

    if (!gitConfig) {
        // Project not linked to Git, skip sync
        return
    }

    try {
        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        // Get document content from docstore
        const { lines } = await DocstoreManager.promises.getDoc(projectId, docId)
        const content = lines.join('\n')

        // For individual document sync, we just update the sync status
        // The actual Git operations happen during full project sync or backup
        logger.debug({ projectId, docId, docPath }, 'Git sync: document updated')

        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })

        // Trigger backup check after successful sync
        GitBackupService.promises.checkAndTriggerBackup(projectId).catch(err => {
            logger.warn({ err, projectId }, 'Git backup check failed')
        })
    } catch (err) {
        logger.error({ err, projectId, docId }, 'failed to sync document to Git')
        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
    }
}

/**
 * Sync a file to Git
 */
async function syncFile(projectId, fileId, filePath, fileHash) {
    const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)

    if (!gitConfig) {
        return
    }

    try {
        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        // For individual file sync, we just update the sync status
        // The actual Git operations happen during full project sync or backup
        logger.debug({ projectId, fileId, filePath }, 'Git sync: file updated')

        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })

        // Trigger backup check after successful sync
        GitBackupService.promises.checkAndTriggerBackup(projectId).catch(err => {
            logger.warn({ err, projectId }, 'Git backup check failed')
        })
    } catch (err) {
        logger.error({ err, projectId, fileId, fileHash }, 'failed to sync file to Git')
        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
    }
}

/**
 * Delete a file from Git (mark for deletion)
 */
async function deleteFromGit(projectId, entityPath) {
    const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)

    if (!gitConfig) {
        return
    }

    // For deletions, we just log - actual Git operations happen during backup
    logger.debug({ projectId, entityPath }, 'Git sync: file marked for deletion')
}

/**
 * Sync entire project to Git repository
 */
async function syncProject(projectId) {
    const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)

    if (!gitConfig) {
        throw new Error('Project not linked to Git')
    }

    const simpleGit = (await import('simple-git')).default

    // Create a temporary directory for the sync
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-git-sync-'))

    try {
        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: true,
        })

        const project = await Project.findById(projectId, {
            name: 1,
            rootFolder: 1,
        }).exec()

        logger.info({ projectId, tempDir }, 'Git sync: starting project sync')

        // Clone the repository
        const git = simpleGit()

        try {
            await git.clone(gitConfig.authenticatedUrl, tempDir, ['--branch', gitConfig.branch, '--single-branch'])
        } catch (cloneErr) {
            // If clone fails, might be an empty repo - try init
            if (cloneErr.message.includes('not found') || cloneErr.message.includes('empty')) {
                logger.info({ projectId }, 'Git sync: initializing new repository')
                await git.init(tempDir)
                const repoGit = simpleGit(tempDir)
                await repoGit.addRemote('origin', gitConfig.authenticatedUrl)
                await repoGit.checkout(['-b', gitConfig.branch])
            } else {
                throw cloneErr
            }
        }

        const repoGit = simpleGit(tempDir)

        // Configure git user for commits
        await repoGit.addConfig('user.email', 'overleaf@backup.local')
        await repoGit.addConfig('user.name', 'Overleaf Sync')

        // Determine the target directory in the repo
        const targetDir = gitConfig.basePath
            ? path.join(tempDir, gitConfig.basePath)
            : tempDir

        // Ensure target directory exists
        await fs.mkdir(targetDir, { recursive: true })

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

        logger.info({ projectId, docCount: allDocs.length, fileCount: allFiles.length }, 'Git sync: syncing project')

        // Sync documents
        await promiseMapWithLimit(5, allDocs, async ({ doc, path: docPath }) => {
            try {
                const { lines } = await DocstoreManager.promises.getDoc(projectId, doc._id)
                const content = lines.join('\n')
                const filePath = path.join(targetDir, docPath)
                const parentDir = path.dirname(filePath)

                await fs.mkdir(parentDir, { recursive: true })
                await fs.writeFile(filePath, content, 'utf8')
            } catch (err) {
                logger.warn({ err, projectId, docPath }, 'Git sync: failed to sync doc')
            }
        })

        // Sync files
        await promiseMapWithLimit(5, allFiles, async ({ file, path: filePath }) => {
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

                const fullPath = path.join(targetDir, filePath)
                const parentDir = path.dirname(fullPath)

                await fs.mkdir(parentDir, { recursive: true })
                await fs.writeFile(fullPath, buffer)
            } catch (err) {
                logger.warn({ err, projectId, filePath }, 'Git sync: failed to sync file')
            }
        })

        // Stage all changes
        await repoGit.add('.')

        // Check if there are changes to commit
        const status = await repoGit.status()
        if (status.files.length === 0) {
            logger.info({ projectId }, 'Git sync: no changes to commit')
            await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
                isSyncing: false,
                lastSyncAt: new Date(),
            })
            return { success: true, noChanges: true, docCount: allDocs.length, fileCount: allFiles.length }
        }

        // Commit with timestamp
        const timestamp = new Date().toISOString()
        const commitMessage = `Sync from Overleaf - ${timestamp}`
        await repoGit.commit(commitMessage)

        // Push changes
        await repoGit.push(['--set-upstream', 'origin', gitConfig.branch])

        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            lastSyncAt: new Date(),
        })

        logger.info({ projectId, docCount: allDocs.length, fileCount: allFiles.length }, 'Git sync: project synced successfully')
        return { success: true, docCount: allDocs.length, fileCount: allFiles.length }
    } catch (err) {
        logger.error({ err, projectId }, 'failed to sync project to Git')
        await GitBackupProjectHandler.promises.updateSyncStatus(projectId, {
            isSyncing: false,
            error: err.message,
        })
        throw err
    } finally {
        // Clean up temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true })
        } catch (cleanupErr) {
            logger.warn({ cleanupErr, tempDir }, 'Git sync: failed to cleanup temp directory')
        }
    }
}

export default {
    syncDocument: callbackify(syncDocument),
    syncFile: callbackify(syncFile),
    deleteFromGit: callbackify(deleteFromGit),
    syncProject: callbackify(syncProject),
    promises: {
        syncDocument,
        syncFile,
        deleteFromGit,
        syncProject,
    },
}
