import { Project } from '../../models/Project.mjs'
import { callbackify } from 'node:util'
import OError from '@overleaf/o-error'
import { WebDAVPersistor } from '@overleaf/object-persistor'

const ProjectUpdateHandler = {
  async markAsUpdated(projectId, lastUpdatedAt, lastUpdatedBy) {
    if (!lastUpdatedAt) {
      lastUpdatedAt = new Date()
    }

    const conditions = {
      _id: projectId,
      lastUpdated: { $lt: lastUpdatedAt },
    }

    const update = {
      lastUpdated: lastUpdatedAt || new Date().getTime(),
      lastUpdatedBy,
    }
    await Project.updateOne(conditions, update, {}).exec()
  },

  async markAsOpened(projectId) {
    const conditions = { _id: projectId }
    const update = { lastOpened: Date.now() }
    await Project.updateOne(conditions, update, {}).exec()
  },

  async markAsInactive(projectId) {
    const conditions = { _id: projectId }
    const update = { active: false }
    await Project.updateOne(conditions, update, {}).exec()
  },

  async markAsActive(projectId) {
    const conditions = { _id: projectId }
    const update = { active: true }
    await Project.updateOne(conditions, update, {}).exec()
  },

  async setWebDAVConfig(projectId, webdavConfig) {
    // Check if the directory is empty
    const persistor = new WebDAVPersistor({
      url: webdavConfig.url,
      username: webdavConfig.username,
      password: webdavConfig.password,
      basePath: webdavConfig.basePath || '/overleaf',
    })

    try {
      const exists = await persistor.checkIfObjectExists(projectId, '')
      if (exists) {
        const keys = await persistor.listDirectoryKeys(projectId, '')
        if (keys.length > 0) {
          throw new OError('WebDAV directory is not empty', {
            info: { public: { message: 'webdav_directory_not_empty' } },
          })
        }
      }
    } catch (err) {
      if (err.info?.public?.message === 'webdav_directory_not_empty') {
        throw err
      }
      throw new OError({
        message: 'failed to connect to webdav',
        cause: err,
        info: { public: { message: 'webdav_connection_failed' } },
      })
    }

    const conditions = { _id: projectId }
    const update = {
      webdavConfig: {
        url: webdavConfig.url,
        username: webdavConfig.username,
        password: webdavConfig.password,
        basePath: webdavConfig.basePath || '/overleaf',
        enabled: true,
        lastSyncDate: new Date(),
      },
    }
    await Project.updateOne(conditions, update, {}).exec()
  },

  async unsetWebDAVConfig(projectId) {
    const conditions = { _id: projectId }
    const update = {
      $unset: {
        webdavConfig: '',
      },
    }
    await Project.updateOne(conditions, update, {}).exec()
  },
}

export default {
  markAsUpdated: callbackify(ProjectUpdateHandler.markAsUpdated),
  markAsOpened: callbackify(ProjectUpdateHandler.markAsOpened),
  markAsInactive: callbackify(ProjectUpdateHandler.markAsInactive),
  markAsActive: callbackify(ProjectUpdateHandler.markAsActive),
  setWebDAVConfig: callbackify(ProjectUpdateHandler.setWebDAVConfig),
  unsetWebDAVConfig: callbackify(ProjectUpdateHandler.unsetWebDAVConfig),
  promises: ProjectUpdateHandler,
}
