import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Form, Alert, Spinner } from 'react-bootstrap'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'
import { useProjectContext } from '@/shared/context/project-context'
import { postJSON, getJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'

type WebDAVStatus = {
    enabled: boolean
    url?: string
    basePath?: string
    syncStatus?: {
        lastSyncAt?: string
        lastSyncError?: string
        isSyncing?: boolean
    }
    linkedAt?: string
}

export default function SettingsWebDAV() {
    const { t } = useTranslation()
    const { write } = usePermissionsContext()
    const { projectId } = useProjectContext()

    const [status, setStatus] = useState<WebDAVStatus>({ enabled: false })
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    // Form fields
    const [url, setUrl] = useState('')
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [basePath, setBasePath] = useState(`/overleaf/${projectId}`)
    const [showLinkForm, setShowLinkForm] = useState(false)
    const [testing, setTesting] = useState(false)
    const [syncing, setSyncing] = useState(false)

    useEffect(() => {
        loadStatus()
    }, [projectId])

    const loadStatus = async () => {
        try {
            setLoading(true)
            const data = await getJSON<WebDAVStatus>(
                `/project/${projectId}/webdav/status`
            )
            setStatus(data)
        } catch (err) {
            debugConsole.error('Failed to load WebDAV status', err)
        } finally {
            setLoading(false)
        }
    }

    const handleTestConnection = async () => {
        setTesting(true)
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/webdav/test`, {
                body: { url, username, password, basePath },
            })
            setSuccess(t('webdav_connection_successful'))
        } catch (err: any) {
            setError(err.message || t('webdav_connection_failed'))
        } finally {
            setTesting(false)
        }
    }

    const handleLink = async () => {
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/webdav/link`, {
                body: { url, username, password, basePath },
            })
            setSuccess(t('webdav_linked_successfully'))
            setShowLinkForm(false)
            await loadStatus()

            // Clear sensitive data
            setPassword('')
        } catch (err: any) {
            setError(err.message || t('webdav_link_failed'))
        }
    }

    const handleUnlink = async (deleteRemote: boolean) => {
        if (!window.confirm(
            deleteRemote
                ? t('webdav_confirm_unlink_delete')
                : t('webdav_confirm_unlink_keep')
        )) {
            return
        }

        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/webdav/unlink`, {
                body: { deleteRemote },
            })
            setSuccess(
                deleteRemote
                    ? t('webdav_unlinked_deleted')
                    : t('webdav_unlinked_kept')
            )
            await loadStatus()
        } catch (err: any) {
            setError(err.message || t('webdav_unlink_failed'))
        }
    }

    const handleSync = async () => {
        setSyncing(true)
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/webdav/sync`, { body: {} })
            setSuccess(t('webdav_sync_started'))
            await loadStatus()
        } catch (err: any) {
            setError(err.message || t('webdav_sync_failed'))
        } finally {
            setSyncing(false)
        }
    }

    if (loading) {
        return (
            <div className="settings-webdav" style={{ textAlign: 'center', padding: '16px' }}>
                <Spinner animation="border" size="sm" />
            </div>
        )
    }

    return (
        <div className="settings-webdav" style={{ padding: '8px 16px' }}>
            <h4 style={{ marginBottom: '8px' }}>{t('webdav_storage')}</h4>
            {error && <Alert variant="danger" style={{ fontSize: '12px', padding: '8px' }}>{error}</Alert>}
            {success && <Alert variant="success" style={{ fontSize: '12px', padding: '8px' }}>{success}</Alert>}

            {!status.enabled && !showLinkForm && (
                <div>
                    <p style={{ fontSize: '13px' }}>{t('webdav_not_linked')}</p>
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setShowLinkForm(true)}
                        disabled={!write}
                        style={{ width: '100%' }}
                    >
                        {t('webdav_link_project')}
                    </Button>
                </div>
            )}

            {!status.enabled && showLinkForm && (
                <Form>
                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('webdav_server_url')}</Form.Label>
                        <Form.Control
                            type="url"
                            size="sm"
                            value={url}
                            onChange={(e: any) => setUrl(e.target.value)}
                            placeholder="https://webdav.example.com"
                            required
                        />
                    </Form.Group>

                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('username')}</Form.Label>
                        <Form.Control
                            type="text"
                            size="sm"
                            value={username}
                            onChange={(e: any) => setUsername(e.target.value)}
                            required
                        />
                    </Form.Group>

                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('password')}</Form.Label>
                        <Form.Control
                            type="password"
                            size="sm"
                            value={password}
                            onChange={(e: any) => setPassword(e.target.value)}
                            required
                        />
                    </Form.Group>

                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('webdav_base_path')}</Form.Label>
                        <Form.Control
                            type="text"
                            size="sm"
                            value={basePath}
                            onChange={(e: any) => setBasePath(e.target.value)}
                        />
                    </Form.Group>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleTestConnection}
                            disabled={testing || !url || !username || !password}
                            style={{ width: '100%' }}
                        >
                            {testing ? <Spinner animation="border" size="sm" /> : t('test_connection')}
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleLink}
                            disabled={!url || !username || !password}
                            style={{ width: '100%' }}
                        >
                            {t('link')}
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setShowLinkForm(false)}
                            style={{ width: '100%' }}
                        >
                            {t('cancel')}
                        </Button>
                    </div>
                </Form>
            )}

            {status.enabled && (
                <div>
                    <Alert variant="success" style={{ fontSize: '12px', padding: '8px' }}>
                        <strong>{t('webdav_linked')}</strong>
                        <div style={{ marginTop: '4px' }}>
                            <small>
                                <strong>{t('url')}:</strong> {status.url}
                                <br />
                                <strong>{t('path')}:</strong> {status.basePath}
                            </small>
                        </div>
                    </Alert>

                    {status.syncStatus && (
                        <div style={{ marginBottom: '8px', fontSize: '12px' }}>
                            {status.syncStatus.isSyncing && (
                                <div>
                                    <Spinner animation="border" size="sm" style={{ marginRight: '4px' }} />
                                    {t('syncing')}
                                </div>
                            )}
                            {status.syncStatus.lastSyncAt && (
                                <div>
                                    <small>
                                        <strong>{t('last_sync')}:</strong>{' '}
                                        {new Date(status.syncStatus.lastSyncAt).toLocaleString()}
                                    </small>
                                </div>
                            )}
                            {status.syncStatus.lastSyncError && (
                                <Alert variant="warning" style={{ fontSize: '11px', padding: '4px 8px', marginTop: '4px' }}>
                                    {status.syncStatus.lastSyncError}
                                </Alert>
                            )}
                        </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleSync}
                            disabled={syncing || status.syncStatus?.isSyncing}
                            style={{ width: '100%' }}
                        >
                            {syncing || status.syncStatus?.isSyncing ? (
                                <Spinner animation="border" size="sm" />
                            ) : (
                                t('sync_now')
                            )}
                        </Button>
                        <Button
                            variant="warning"
                            size="sm"
                            onClick={() => handleUnlink(false)}
                            disabled={!write}
                            style={{ width: '100%' }}
                        >
                            {t('webdav_unlink_keep')}
                        </Button>
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleUnlink(true)}
                            disabled={!write}
                            style={{ width: '100%' }}
                        >
                            {t('webdav_unlink_delete')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
