import crypto from 'node:crypto'
import { callbackify } from 'node:util'
import { Project } from '../../models/Project.mjs'
import Settings from '@overleaf/settings'
import logger from '@overleaf/logger'
import Errors from '../Errors/Errors.js'
import { createClient } from 'webdav'

const ENCRYPTION_ALGORITHM = 'aes-256-cbc'
const ENCRYPTION_KEY = Settings.webdav?.encryptionKey || 'default-key-change-me-32-chars!!'

/**
 * Handler for WebDAV project operations
 */

/**
 * Encrypt sensitive data
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
 * Decrypt sensitive data
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
 * Validate WebDAV connection
 */
async function validateWebDAVConnection(webdavConfig) {
    try {
        const client = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password,
            timeout: 10000,
        })

        // Test connection by checking if base path exists or can be created
        const basePath = webdavConfig.basePath || '/'
        const exists = await client.exists(basePath)

        if (!exists) {
            await client.createDirectory(basePath, { recursive: true })
        }

        return { success: true }
    } catch (err) {
        logger.error({ err, url: webdavConfig.url }, 'WebDAV connection validation failed')
        throw new Errors.InvalidError('WebDAV connection failed: ' + err.message)
    }
}

/**
 * Link a project to WebDAV
 */
async function linkProjectToWebDAV(projectId, webdavConfig) {
    logger.info({ projectId }, 'linking project to WebDAV')

    // Validate connection first
    await validateWebDAVConnection(webdavConfig)

    // Encrypt password
    const encryptedPassword = encryptCredentials(webdavConfig.password)

    // Update project with WebDAV config
    await Project.updateOne(
        { _id: projectId },
        {
            $set: {
                'webdav.enabled': true,
                'webdav.url': webdavConfig.url,
                'webdav.username': webdavConfig.username,
                'webdav.password': encryptedPassword,
                'webdav.basePath': webdavConfig.basePath || `/overleaf/${projectId}`,
                'webdav.linkedAt': new Date(),
                'webdav.unlinkedAt': null,
            },
        }
    ).exec()

    logger.info({ projectId }, 'project linked to WebDAV successfully')
    return { success: true }
}

/**
 * Unlink a project from WebDAV
 */
async function unlinkProjectFromWebDAV(projectId, deleteRemote = false) {
    logger.info({ projectId, deleteRemote }, 'unlinking project from WebDAV')

    const project = await Project.findById(projectId).exec()
    if (!project) {
        throw new Errors.NotFoundError('project not found')
    }

    if (!project.webdav || !project.webdav.enabled) {
        throw new Errors.InvalidError('project is not linked to WebDAV')
    }

    // If deleteRemote is true, delete files from WebDAV server
    if (deleteRemote) {
        try {
            const password = decryptCredentials(project.webdav.password)
            const client = createClient(project.webdav.url, {
                username: project.webdav.username,
                password: password,
                timeout: 30000,
            })

            const basePath = project.webdav.basePath
            const exists = await client.exists(basePath)
            if (exists) {
                await client.deleteFile(basePath)
                logger.info({ projectId, basePath }, 'deleted WebDAV files')
            }
        } catch (err) {
            logger.error({ err, projectId }, 'failed to delete WebDAV files')
            // Continue with unlinking even if deletion fails
        }
    }

    // Update project to disable WebDAV
    await Project.updateOne(
        { _id: projectId },
        {
            $set: {
                'webdav.enabled': false,
                'webdav.unlinkedAt': new Date(),
            },
        }
    ).exec()

    logger.info({ projectId }, 'project unlinked from WebDAV successfully')
    return { success: true, deletedRemote: deleteRemote }
}

/**
 * Get WebDAV client for a project
 */
async function getWebDAVClient(projectId) {
    const project = await Project.findById(projectId, {
        'webdav.enabled': 1,
        'webdav.url': 1,
        'webdav.username': 1,
        'webdav.password': 1,
        'webdav.basePath': 1,
    }).exec()

    if (!project || !project.webdav || !project.webdav.enabled) {
        return null
    }

    const password = decryptCredentials(project.webdav.password)
    const client = createClient(project.webdav.url, {
        username: project.webdav.username,
        password: password,
        timeout: 30000,
    })

    return {
        client,
        basePath: project.webdav.basePath,
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
                'webdav.syncStatus.lastSyncAt': status.lastSyncAt || new Date(),
                'webdav.syncStatus.lastSyncError': status.error || null,
                'webdav.syncStatus.isSyncing': status.isSyncing || false,
            },
        }
    ).exec()
}

export default {
    linkProjectToWebDAV: callbackify(linkProjectToWebDAV),
    unlinkProjectFromWebDAV: callbackify(unlinkProjectFromWebDAV),
    validateWebDAVConnection: callbackify(validateWebDAVConnection),
    encryptCredentials,
    decryptCredentials,
    getWebDAVClient: callbackify(getWebDAVClient),
    updateSyncStatus: callbackify(updateSyncStatus),
    promises: {
        linkProjectToWebDAV,
        unlinkProjectFromWebDAV,
        validateWebDAVConnection,
        getWebDAVClient,
        updateSyncStatus,
    },
}
