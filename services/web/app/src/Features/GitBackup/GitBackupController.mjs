import logger from '@overleaf/logger'
import GitBackupProjectHandler from './GitBackupProjectHandler.mjs'
import GitBackupSyncService from './GitBackupSyncService.mjs'
import { Project } from '../../models/Project.mjs'

/**
 * Controller for Git Backup API endpoints
 */

/**
 * Link a project to Git repository
 */
async function linkProject(req, res, next) {
    const projectId = req.params.Project_id
    const { repoUrl, branch, username, accessToken, basePath, commitMessage } = req.body

    try {
        // Validate input
        if (!repoUrl || !username || !accessToken) {
            return res.status(400).json({ error: 'Missing required fields' })
        }

        const gitConfig = {
            repoUrl,
            branch: branch || 'main',
            username,
            accessToken,
            basePath: basePath || '',
            commitMessage: commitMessage || 'Auto backup from Overleaf',
        }

        // Link project to Git
        await GitBackupProjectHandler.promises.linkProjectToGit(
            projectId,
            gitConfig
        )

        // Trigger initial sync
        GitBackupSyncService.promises.syncProject(projectId).catch(err => {
            logger.error({ err, projectId }, 'initial Git sync failed')
        })

        res.json({ success: true })
    } catch (err) {
        logger.error({ err, projectId }, 'failed to link project to Git')
        next(err)
    }
}

/**
 * Unlink a project from Git repository
 */
async function unlinkProject(req, res, next) {
    const projectId = req.params.Project_id
    const { deleteRemote } = req.body

    try {
        const result = await GitBackupProjectHandler.promises.unlinkProjectFromGit(
            projectId,
            deleteRemote === true
        )

        res.json(result)
    } catch (err) {
        logger.error({ err, projectId }, 'failed to unlink project from Git')
        next(err)
    }
}

/**
 * Manually trigger project sync
 */
async function syncProject(req, res, next) {
    const projectId = req.params.Project_id

    try {
        const result = await GitBackupSyncService.promises.syncProject(projectId)
        res.json(result)
    } catch (err) {
        logger.error({ err, projectId }, 'failed to sync project to Git')
        next(err)
    }
}

/**
 * Get Git sync status
 */
async function getStatus(req, res, next) {
    const projectId = req.params.Project_id

    try {
        const project = await Project.findById(projectId, {
            'gitBackup.enabled': 1,
            'gitBackup.repoUrl': 1,
            'gitBackup.branch': 1,
            'gitBackup.basePath': 1,
            'gitBackup.syncStatus': 1,
            'gitBackup.linkedAt': 1,
        }).exec()

        if (!project || !project.gitBackup || !project.gitBackup.enabled) {
            return res.json({ enabled: false })
        }

        res.json({
            enabled: true,
            repoUrl: project.gitBackup.repoUrl,
            branch: project.gitBackup.branch,
            basePath: project.gitBackup.basePath,
            syncStatus: project.gitBackup.syncStatus,
            linkedAt: project.gitBackup.linkedAt,
        })
    } catch (err) {
        logger.error({ err, projectId }, 'failed to get Git status')
        next(err)
    }
}

/**
 * Test Git connection
 */
async function testConnection(req, res, next) {
    const { repoUrl, branch, username, accessToken } = req.body

    try {
        if (!repoUrl || !username || !accessToken) {
            return res.status(400).json({ error: 'Missing required fields' })
        }

        const gitConfig = { repoUrl, branch: branch || 'main', username, accessToken }
        await GitBackupProjectHandler.promises.validateGitConnection(gitConfig)

        res.json({ success: true, message: 'Connection successful' })
    } catch (err) {
        logger.error({ err, repoUrl }, 'Git connection test failed')
        res.status(400).json({ success: false, error: err.message })
    }
}

/**
 * Get backup settings
 */
async function getBackupSettings(req, res, next) {
    const projectId = req.params.Project_id

    try {
        const settings = await GitBackupProjectHandler.promises.getBackupSettings(projectId)
        res.json(settings)
    } catch (err) {
        logger.error({ err, projectId }, 'failed to get backup settings')
        next(err)
    }
}

/**
 * Update backup settings
 */
async function updateBackupSettings(req, res, next) {
    const projectId = req.params.Project_id
    const { enabled, modificationThreshold, intervalMinutes, maxBackups } = req.body

    try {
        const result = await GitBackupProjectHandler.promises.updateBackupSettings(projectId, {
            enabled,
            modificationThreshold,
            intervalMinutes,
            maxBackups,
        })
        res.json(result)
    } catch (err) {
        logger.error({ err, projectId }, 'failed to update backup settings')
        next(err)
    }
}

export default {
    linkProject,
    unlinkProject,
    syncProject,
    getStatus,
    testConnection,
    getBackupSettings,
    updateBackupSettings,
}
