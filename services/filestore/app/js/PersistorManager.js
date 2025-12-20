import settings from '@overleaf/settings'
import ObjectPersistor from '@overleaf/object-persistor'

const persistorSettings = settings.filestore
persistorSettings.paths = settings.path
const ProjectConfigProvider = require('./ProjectConfigProvider.js')
const { SyncPersistor } = require('@overleaf/object-persistor')

let persistor = ObjectPersistor(persistorSettings)

// Wrap with dynamic SyncPersistor
persistor = new SyncPersistor(persistor, ProjectConfigProvider)

export default persistor
