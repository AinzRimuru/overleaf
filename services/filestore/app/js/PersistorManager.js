import settings from '@overleaf/settings'
import ObjectPersistor from '@overleaf/object-persistor'

const persistorSettings = settings.filestore
persistorSettings.paths = settings.path
import ProjectConfigProvider from './ProjectConfigProvider.js'
const { SyncPersistor } = ObjectPersistor

let persistor = ObjectPersistor(persistorSettings)
console.error(` [Filestore] Primary persistor created: ${persistor.constructor.name}`)

// Wrap with dynamic SyncPersistor
console.error(' [Filestore] Wrapping persistor with SyncPersistor')
persistor = new SyncPersistor(persistor, ProjectConfigProvider)
console.error(` [Filestore] Wrapped persistor type: ${persistor.constructor.name}`)
console.error(` [Filestore] Persistor has sendStream: ${typeof persistor.sendStream}`)

export default persistor
