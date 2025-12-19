import { callbackify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import logger from '@overleaf/logger'
import { Project } from '../../models/Project.mjs'
import GitBackupProjectHandler from './GitBackupProjectHandler.mjs'

/**
 * Service for Git backup functionality
 * 
 * Backup logic (same as WebDAV):
 * 1. When a file modification triggers Git sync, checkAndTriggerBackup is called
 * 2. If current time < nextCheckTime, skip (don't count this modification)
 * 3. If current time >= nextCheckTime, increment modificationCount and update nextCheckTime
 * 4. If modificationCount >= modificationThreshold, create a backup and reset counter
 * 5. After creating backup, cleanup old backups if exceeding maxBackups
 */

/**
 * Check if a backup should be triggered and create it if conditions are met
 * Called after each successful Git sync operation
 */
async function checkAndTriggerBackup(projectId) {
    try {
        const project = await Project.findById(projectId, {
            'gitBackup.enabled': 1,
            'gitBackup.backup': 1,
            'gitBackup.basePath': 1,
        }).exec()

        // Skip if Git backup or backup feature is not enabled
        if (!project?.gitBackup?.enabled || !project?.gitBackup?.backup?.enabled) {
            return { triggered: false, reason: 'backup_not_enabled' }
        }

        const backup = project.gitBackup.backup
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
            'Git backup: incrementing modification count'
        )

        // Check if we should trigger a backup
        if (newCount >= threshold) {
            // Time to create a backup
            logger.info({ projectId, newCount, threshold }, 'Git backup: triggering backup')

            // Reset counter and update timestamps
            await Project.updateOne(
                { _id: projectId },
                {
                    $set: {
                        'gitBackup.backup.modificationCount': 0,
                        'gitBackup.backup.nextCheckTime': nextCheckTime,
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
                        'gitBackup.backup.modificationCount': newCount,
                        'gitBackup.backup.nextCheckTime': nextCheckTime,
                    },
                }
            ).exec()

            return { triggered: false, reason: 'threshold_not_reached', count: newCount }
        }
    } catch (err) {
        logger.error({ err, projectId }, 'Git backup: failed to check/trigger backup')
        return { triggered: false, reason: 'error', error: err.message }
    }
}

/**
 * Create a backup of the project to Git
 * Creates a tagged commit with timestamp
 */
async function createBackup(projectId) {
    const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)

    if (!gitConfig) {
        throw new Error('Project not linked to Git')
    }

    const simpleGit = (await import('simple-git')).default

    // Create a temporary directory for the backup
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-git-backup-'))

    try {
        const project = await Project.findById(projectId, {
            name: 1,
            rootFolder: 1,
        }).exec()

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const tagName = `backup-${timestamp}`

        logger.info({ projectId, tempDir, tagName }, 'Git backup: creating backup')

        // Clone the repository
        const git = simpleGit()
        await git.clone(gitConfig.authenticatedUrl, tempDir, ['--branch', gitConfig.branch, '--single-branch'])

        // Change to the repo directory
        const repoGit = simpleGit(tempDir)

        // Configure git user for commits
        await repoGit.addConfig('user.email', 'overleaf@backup.local')
        await repoGit.addConfig('user.name', 'Overleaf Backup')

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

        // Import required modules
        const DocstoreManager = (await import('../Docstore/DocstoreManager.mjs')).default
        const HistoryManager = (await import('../History/HistoryManager.mjs')).default
        const { promiseMapWithLimit } = await import('@overleaf/promise-utils')

        // Backup documents
        await promiseMapWithLimit(5, allDocs, async ({ doc, path: docPath }) => {
            try {
                const { lines } = await DocstoreManager.promises.getDoc(projectId, doc._id)
                const content = lines.join('\n')
                const filePath = path.join(targetDir, docPath)
                const parentDir = path.dirname(filePath)

                await fs.mkdir(parentDir, { recursive: true })
                await fs.writeFile(filePath, content, 'utf8')
            } catch (err) {
                logger.warn({ err, projectId, docPath }, 'Git backup: failed to backup doc')
            }
        })

        // Backup files
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
                logger.warn({ err, projectId, filePath }, 'Git backup: failed to backup file')
            }
        })

        // Stage all changes
        await repoGit.add('.')

        // Check if there are changes to commit
        const status = await repoGit.status()
        if (status.files.length === 0) {
            logger.info({ projectId }, 'Git backup: no changes to commit')
            return { success: true, noChanges: true }
        }

        // Commit with timestamp
        const commitMessage = `${gitConfig.commitMessage} - ${timestamp}`
        await repoGit.commit(commitMessage)

        // Create a tag for this backup
        await repoGit.addTag(tagName)

        // Push changes and tags
        await repoGit.push('origin', gitConfig.branch)
        await repoGit.pushTags('origin')

        // Update last backup time
        await Project.updateOne(
            { _id: projectId },
            {
                $set: {
                    'gitBackup.backup.lastBackupAt': new Date(),
                },
            }
        ).exec()

        logger.info(
            { projectId, tagName, docCount: allDocs.length, fileCount: allFiles.length },
            'Git backup: backup created successfully'
        )

        return {
            success: true,
            tagName,
            docCount: allDocs.length,
            fileCount: allFiles.length,
        }
    } catch (err) {
        logger.error({ err, projectId }, 'Git backup: failed to create backup')
        throw err
    } finally {
        // Clean up temp directory
        try {
            await fs.rm(tempDir, { recursive: true, force: true })
        } catch (cleanupErr) {
            logger.warn({ cleanupErr, tempDir }, 'Git backup: failed to cleanup temp directory')
        }
    }
}

/**
 * List all backups (tags) on Git for a project
 */
async function listBackups(projectId) {
    const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)

    if (!gitConfig) {
        throw new Error('Project not linked to Git')
    }

    const simpleGit = (await import('simple-git')).default

    try {
        const git = simpleGit()

        // List remote tags
        const result = await git.listRemote(['--tags', gitConfig.authenticatedUrl])

        // Parse tags - format: "sha1\trefs/tags/tagname"
        const backups = result
            .split('\n')
            .filter(line => line.includes('refs/tags/backup-'))
            .map(line => {
                const parts = line.split('\t')
                const tagPath = parts[1] || ''
                const tagName = tagPath.replace('refs/tags/', '').replace('^{}', '')

                // Extract timestamp from tag name (backup-YYYY-MM-DDTHH-MM-SS-SSSZ)
                const timestampMatch = tagName.match(/backup-(.+)/)
                const timestamp = timestampMatch
                    ? timestampMatch[1].replace(/-/g, (m, i) => i < 10 ? '-' : i < 13 ? ':' : i < 16 ? ':' : '.')
                    : null

                return {
                    name: tagName,
                    createdAt: timestamp,
                }
            })
            .filter(b => b.name)
            .sort((a, b) => b.name.localeCompare(a.name)) // Sort newest first

        return backups
    } catch (err) {
        logger.error({ err, projectId }, 'Git backup: failed to list backups')
        throw err
    }
}

/**
 * Cleanup old backups exceeding the maximum count
 */
async function cleanupOldBackups(projectId) {
    try {
        const project = await Project.findById(projectId, {
            'gitBackup.backup.maxBackups': 1,
        }).exec()

        const maxBackups = project?.gitBackup?.backup?.maxBackups || 10
        const backups = await listBackups(projectId)

        if (backups.length <= maxBackups) {
            return { deleted: 0 }
        }

        const gitConfig = await GitBackupProjectHandler.promises.getGitClient(projectId)
        if (!gitConfig) {
            return { deleted: 0 }
        }

        const simpleGit = (await import('simple-git')).default

        // Create temp dir for git operations
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'overleaf-git-cleanup-'))

        try {
            // Clone with minimal depth
            const git = simpleGit()
            await git.clone(gitConfig.authenticatedUrl, tempDir, ['--branch', gitConfig.branch, '--depth', '1'])

            const repoGit = simpleGit(tempDir)

            // Delete oldest backups (they're sorted newest first)
            const backupsToDelete = backups.slice(maxBackups)
            let deleted = 0

            for (const backup of backupsToDelete) {
                try {
                    // Delete remote tag
                    await repoGit.push(['origin', `:refs/tags/${backup.name}`])
                    deleted++
                    logger.debug({ projectId, tagName: backup.name }, 'Git backup: deleted old backup tag')
                } catch (err) {
                    logger.warn({ err, projectId, tagName: backup.name }, 'Git backup: failed to delete old backup tag')
                }
            }

            logger.info({ projectId, deleted, total: backups.length }, 'Git backup: cleaned up old backups')
            return { deleted }
        } finally {
            // Cleanup temp directory
            try {
                await fs.rm(tempDir, { recursive: true, force: true })
            } catch (cleanupErr) {
                logger.warn({ cleanupErr, tempDir }, 'Git backup: failed to cleanup temp directory')
            }
        }
    } catch (err) {
        logger.error({ err, projectId }, 'Git backup: failed to cleanup old backups')
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
