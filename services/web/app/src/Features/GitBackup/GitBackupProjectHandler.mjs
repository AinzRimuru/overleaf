import crypto from 'node:crypto'
import { callbackify } from 'node:util'
import { Project } from '../../models/Project.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Errors from '../Errors/Errors.js'

const ENCRYPTION_ALGORITHM = 'aes-256-cbc'
const ENCRYPTION_KEY = Settings.gitBackup?.encryptionKey || Settings.webdav?.encryptionKey || 'default-key-change-me-32-chars!!'

/**
 * Handler for Git Backup project operations
 */

/**
 * Encrypt sensitive data (access token)
 */
function encryptCredentials(text) {
    const iv = crypto.randomBytes(16)
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32))
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return iv.toString('hex') + ':' + encrypted
}

/**
 * Decrypt sensitive data (access token)
 */
function decryptCredentials(encrypted) {
    const parts = encrypted.split(':')
    const iv = Buffer.from(parts.shift(), 'hex')
    const encryptedText = parts.join(':')
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32))
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv)
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
}

/**
 * Parse Git repository URL to extract components
 */
function parseGitUrl(repoUrl) {
    // Support formats:
    // https://github.com/user/repo.git
    // https://gitlab.com/user/repo.git
    // git@github.com:user/repo.git

    let url = repoUrl.trim()

    // Remove .git suffix if present
    if (url.endsWith('.git')) {
        url = url.slice(0, -4)
    }

    // Handle SSH format
    if (url.startsWith('git@')) {
        const match = url.match(/git@([^:]+):(.+)/)
        if (match) {
            return {
                host: match[1],
                path: match[2],
                isSSH: true,
            }
        }
    }

    // Handle HTTPS format
    try {
        const parsed = new URL(url)
        return {
            host: parsed.host,
            path: parsed.pathname.replace(/^\//, ''),
            isSSH: false,
        }
    } catch (err) {
        throw new Errors.InvalidError('Invalid Git repository URL')
    }
}

/**
 * Build authenticated clone URL
 */
function buildAuthenticatedUrl(repoUrl, username, accessToken) {
    const parsed = parseGitUrl(repoUrl)

    if (parsed.isSSH) {
        // For SSH, we can't easily inject credentials
        // Return as-is and rely on SSH key authentication
        return repoUrl
    }

    // Build HTTPS URL with credentials
    const protocol = 'https://'
    const credentials = username && accessToken
        ? `${encodeURIComponent(username)}:${encodeURIComponent(accessToken)}@`
        : ''

    return `${protocol}${credentials}${parsed.host}/${parsed.path}.git`
}

/**
 * Validate Git connection by attempting to list remote refs
 */
async function validateGitConnection(gitConfig) {
    const simpleGit = (await import('simple-git')).default

    try {
        const authenticatedUrl = buildAuthenticatedUrl(
            gitConfig.repoUrl,
            gitConfig.username,
            gitConfig.accessToken
        )

        const git = simpleGit()

        // Try to list remote refs (this validates credentials)
        await git.listRemote([authenticatedUrl])

        return { success: true }
    } catch (err) {
        logger.error({ err, repoUrl: gitConfig.repoUrl }, 'Git connection validation failed')
        throw new Errors.InvalidError('Git connection failed: ' + err.message)
    }
}

/**
 * Link a project to Git repository
 */
async function linkProjectToGit(projectId, gitConfig) {
    logger.info({ projectId }, 'linking project to Git repository')

    // Validate connection first
    await validateGitConnection(gitConfig)

    // Encrypt access token
    const encryptedToken = encryptCredentials(gitConfig.accessToken)

    // Update project with Git config
    await Project.updateOne(
        { _id: projectId },
        {
            $set: {
                'gitBackup.enabled': true,
                'gitBackup.repoUrl': gitConfig.repoUrl,
                'gitBackup.branch': gitConfig.branch || 'main',
                'gitBackup.username': gitConfig.username,
                'gitBackup.accessToken': encryptedToken,
                'gitBackup.basePath': gitConfig.basePath || '',
                'gitBackup.commitMessage': gitConfig.commitMessage || 'Auto backup from Overleaf',
                'gitBackup.linkedAt': new Date(),
                'gitBackup.unlinkedAt': null,
            },
        }
    ).exec()

    logger.info({ projectId }, 'project linked to Git repository successfully')
    return { success: true }
}

/**
 * Unlink a project from Git repository
 */
async function unlinkProjectFromGit(projectId, deleteRemote = false) {
    logger.info({ projectId, deleteRemote }, 'unlinking project from Git repository')

    const project = await Project.findById(projectId).exec()
    if (!project) {
        throw new Errors.NotFoundError('project not found')
    }

    if (!project.gitBackup || !project.gitBackup.enabled) {
        throw new Errors.InvalidError('project is not linked to Git')
    }

    // Note: Deleting remote Git content is complex and risky
    // We'll just log a warning if deleteRemote is true
    if (deleteRemote) {
        logger.warn({ projectId }, 'deleteRemote requested for Git unlink - not implemented for safety')
    }

    // Update project to disable Git backup
    await Project.updateOne(
        { _id: projectId },
        {
            $set: {
                'gitBackup.enabled': false,
                'gitBackup.unlinkedAt': new Date(),
            },
        }
    ).exec()

    logger.info({ projectId }, 'project unlinked from Git repository successfully')
    return { success: true, deletedRemote: false }
}

/**
 * Get Git client configuration for a project
 */
async function getGitClient(projectId) {
    const project = await Project.findById(projectId, {
        'gitBackup.enabled': 1,
        'gitBackup.repoUrl': 1,
        'gitBackup.branch': 1,
        'gitBackup.username': 1,
        'gitBackup.accessToken': 1,
        'gitBackup.basePath': 1,
        'gitBackup.commitMessage': 1,
    }).exec()

    if (!project || !project.gitBackup || !project.gitBackup.enabled) {
        return null
    }

    const accessToken = decryptCredentials(project.gitBackup.accessToken)
    const authenticatedUrl = buildAuthenticatedUrl(
        project.gitBackup.repoUrl,
        project.gitBackup.username,
        accessToken
    )

    return {
        repoUrl: project.gitBackup.repoUrl,
        authenticatedUrl,
        branch: project.gitBackup.branch || 'main',
        basePath: project.gitBackup.basePath || '',
        commitMessage: project.gitBackup.commitMessage || 'Auto backup from Overleaf',
        username: project.gitBackup.username,
    }
}

/**
 * Update sync status
 */
async function updateSyncStatus(projectId, status) {
    await Project.updateOne(
        { _id: projectId },
        {
            $set: {
                'gitBackup.syncStatus.lastSyncAt': status.lastSyncAt || new Date(),
                'gitBackup.syncStatus.lastSyncError': status.error || null,
                'gitBackup.syncStatus.isSyncing': status.isSyncing || false,
            },
        }
    ).exec()
}

/**
 * Update backup settings
 */
async function updateBackupSettings(projectId, settings) {
    const updateFields = {}

    if (typeof settings.enabled === 'boolean') {
        updateFields['gitBackup.backup.enabled'] = settings.enabled
    }
    if (typeof settings.modificationThreshold === 'number' && settings.modificationThreshold > 0) {
        updateFields['gitBackup.backup.modificationThreshold'] = settings.modificationThreshold
    }
    if (typeof settings.intervalMinutes === 'number' && settings.intervalMinutes > 0) {
        updateFields['gitBackup.backup.intervalMinutes'] = settings.intervalMinutes
    }
    if (typeof settings.maxBackups === 'number' && settings.maxBackups > 0) {
        updateFields['gitBackup.backup.maxBackups'] = settings.maxBackups
    }

    if (Object.keys(updateFields).length === 0) {
        return { success: false, message: 'No valid settings to update' }
    }

    await Project.updateOne(
        { _id: projectId },
        { $set: updateFields }
    ).exec()

    logger.info({ projectId, settings: updateFields }, 'Git backup settings updated')
    return { success: true }
}

/**
 * Get backup settings
 */
async function getBackupSettings(projectId) {
    const project = await Project.findById(projectId, {
        'gitBackup.enabled': 1,
        'gitBackup.backup': 1,
    }).exec()

    if (!project || !project.gitBackup) {
        return {
            gitBackupEnabled: false,
            enabled: false,
            modificationThreshold: 6,
            intervalMinutes: 10,
            maxBackups: 10,
            modificationCount: 0,
            lastBackupAt: null,
        }
    }

    const backup = project.gitBackup.backup || {}
    return {
        gitBackupEnabled: project.gitBackup.enabled || false,
        enabled: backup.enabled || false,
        modificationThreshold: backup.modificationThreshold || 6,
        intervalMinutes: backup.intervalMinutes || 10,
        maxBackups: backup.maxBackups || 10,
        modificationCount: backup.modificationCount || 0,
        lastBackupAt: backup.lastBackupAt || null,
    }
}

export default {
    linkProjectToGit: callbackify(linkProjectToGit),
    unlinkProjectFromGit: callbackify(unlinkProjectFromGit),
    validateGitConnection: callbackify(validateGitConnection),
    encryptCredentials,
    decryptCredentials,
    parseGitUrl,
    buildAuthenticatedUrl,
    getGitClient: callbackify(getGitClient),
    updateSyncStatus: callbackify(updateSyncStatus),
    updateBackupSettings: callbackify(updateBackupSettings),
    getBackupSettings: callbackify(getBackupSettings),
    promises: {
        linkProjectToGit,
        unlinkProjectFromGit,
        validateGitConnection,
        getGitClient,
        updateSyncStatus,
        updateBackupSettings,
        getBackupSettings,
    },
}
