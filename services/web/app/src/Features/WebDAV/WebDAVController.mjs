import logger from '@overleaf/logger'
import WebDAVProjectHandler from './WebDAVProjectHandler.mjs'
import WebDAVSyncService from './WebDAVSyncService.mjs'
import { Project } from '../../models/Project.mjs'

/**
 * Controller for WebDAV API endpoints
 */

/**
 * Link a project to WebDAV
 */
async function linkProject(req, res, next) {
    const projectId = req.params.Project_id
    const { url, username, password, basePath } = req.body

    try {
        // Validate input
        if (!url || !username || !password) {
            return res.status(400).json({ error: 'Missing required fields' })
        }

        const webdavConfig = {
            url,
            username,
            password,
            basePath: basePath || `/overleaf/${projectId}`,
        }

        // Link project to WebDAV
        await WebDAVProjectHandler.promises.linkProjectToWebDAV(
            projectId,
            webdavConfig
        )

        // Trigger initial sync
        WebDAVSyncService.promises.syncProject(projectId).catch(err => {
            logger.error({ err, projectId }, 'initial WebDAV sync failed')
        })

        res.json({ success: true })
    } catch (err) {
        logger.error({ err, projectId }, 'failed to link project to WebDAV')
        next(err)
    }
}

/**
 * Unlink a project from WebDAV
 */
async function unlinkProject(req, res, next) {
    const projectId = req.params.Project_id
    const { deleteRemote } = req.body

    try {
        const result = await WebDAVProjectHandler.promises.unlinkProjectFromWebDAV(
            projectId,
            deleteRemote === true
        )

        res.json(result)
    } catch (err) {
        logger.error({ err, projectId }, 'failed to unlink project from WebDAV')
        next(err)
    }
}

/**
 * Manually trigger project sync
 */
async function syncProject(req, res, next) {
    const projectId = req.params.Project_id

    try {
        const result = await WebDAVSyncService.promises.syncProject(projectId)
        res.json(result)
    } catch (err) {
        logger.error({ err, projectId }, 'failed to sync project to WebDAV')
        next(err)
    }
}

/**
 * Get WebDAV sync status
 */
async function getStatus(req, res, next) {
    const projectId = req.params.Project_id

    try {
        const project = await Project.findById(projectId, {
            'webdav.enabled': 1,
            'webdav.url': 1,
            'webdav.basePath': 1,
            'webdav.syncStatus': 1,
            'webdav.linkedAt': 1,
        }).exec()

        if (!project || !project.webdav || !project.webdav.enabled) {
            return res.json({ enabled: false })
        }

        res.json({
            enabled: true,
            url: project.webdav.url,
            basePath: project.webdav.basePath,
            syncStatus: project.webdav.syncStatus,
            linkedAt: project.webdav.linkedAt,
        })
    } catch (err) {
        logger.error({ err, projectId }, 'failed to get WebDAV status')
        next(err)
    }
}

/**
 * Test WebDAV connection
 */
async function testConnection(req, res, next) {
    const { url, username, password, basePath } = req.body

    try {
        if (!url || !username || !password) {
            return res.status(400).json({ error: 'Missing required fields' })
        }

        const webdavConfig = { url, username, password, basePath: basePath || '/' }
        await WebDAVProjectHandler.promises.validateWebDAVConnection(webdavConfig)

        res.json({ success: true, message: 'Connection successful' })
    } catch (err) {
        logger.error({ err, url }, 'WebDAV connection test failed')
        res.status(400).json({ success: false, error: err.message })
    }
}

export default {
    linkProject,
    unlinkProject,
    syncProject,
    getStatus,
    testConnection,
}
