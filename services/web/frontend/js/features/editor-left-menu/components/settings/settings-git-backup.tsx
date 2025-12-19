import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Form, Alert, Spinner } from 'react-bootstrap'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'
import { useProjectContext } from '@/shared/context/project-context'
import { postJSON, getJSON } from '@/infrastructure/fetch-json'
import { debugConsole } from '@/utils/debugging'

type GitBackupStatus = {
    enabled: boolean
    repoUrl?: string
    branch?: string
    basePath?: string
    syncStatus?: {
        lastSyncAt?: string
        lastSyncError?: string
        isSyncing?: boolean
    }
    linkedAt?: string
}

type BackupSettings = {
    gitBackupEnabled: boolean
    enabled: boolean
    modificationThreshold: number
    intervalMinutes: number
    maxBackups: number
    modificationCount: number
    lastBackupAt: string | null
}

export default function SettingsGitBackup() {
    const { t } = useTranslation()
    const { write } = usePermissionsContext()
    const { projectId } = useProjectContext()

    const [status, setStatus] = useState<GitBackupStatus>({ enabled: false })
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [success, setSuccess] = useState<string | null>(null)

    // Form fields
    const [repoUrl, setRepoUrl] = useState('')
    const [branch, setBranch] = useState('main')
    const [username, setUsername] = useState('')
    const [accessToken, setAccessToken] = useState('')
    const [basePath, setBasePath] = useState('')
    const [showLinkForm, setShowLinkForm] = useState(false)
    const [testing, setTesting] = useState(false)
    const [syncing, setSyncing] = useState(false)

    // Backup settings
    const [backupSettings, setBackupSettings] = useState<BackupSettings>({
        gitBackupEnabled: false,
        enabled: false,
        modificationThreshold: 6,
        intervalMinutes: 10,
        maxBackups: 10,
        modificationCount: 0,
        lastBackupAt: null,
    })
    const [savingBackup, setSavingBackup] = useState(false)

    useEffect(() => {
        loadStatus()
        loadBackupSettings()
    }, [projectId])

    const loadStatus = async () => {
        try {
            setLoading(true)
            const data = await getJSON<GitBackupStatus>(
                `/project/${projectId}/git-backup/status`
            )
            setStatus(data)
        } catch (err) {
            debugConsole.error('Failed to load Git backup status', err)
        } finally {
            setLoading(false)
        }
    }

    const loadBackupSettings = async () => {
        try {
            const data = await getJSON<BackupSettings>(
                `/project/${projectId}/git-backup/backup/settings`
            )
            setBackupSettings(data)
        } catch (err) {
            debugConsole.error('Failed to load backup settings', err)
        }
    }

    const handleTestConnection = async () => {
        setTesting(true)
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/git-backup/test`, {
                body: { repoUrl, branch, username, accessToken },
            })
            setSuccess(t('git_backup_connection_successful'))
        } catch (err: any) {
            setError(err.message || t('git_backup_connection_failed'))
        } finally {
            setTesting(false)
        }
    }

    const handleLink = async () => {
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/git-backup/link`, {
                body: { repoUrl, branch, username, accessToken, basePath },
            })
            setSuccess(t('git_backup_linked_successfully'))
            setShowLinkForm(false)
            await loadStatus()
            await loadBackupSettings()

            // Clear sensitive data
            setAccessToken('')
        } catch (err: any) {
            setError(err.message || t('git_backup_link_failed'))
        }
    }

    const handleUnlink = async (deleteRemote: boolean) => {
        if (!window.confirm(
            deleteRemote
                ? t('git_backup_confirm_unlink_delete')
                : t('git_backup_confirm_unlink_keep')
        )) {
            return
        }

        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/git-backup/unlink`, {
                body: { deleteRemote },
            })
            setSuccess(
                deleteRemote
                    ? t('git_backup_unlinked_deleted')
                    : t('git_backup_unlinked_kept')
            )
            await loadStatus()
            await loadBackupSettings()
        } catch (err: any) {
            setError(err.message || t('git_backup_unlink_failed'))
        }
    }

    const handleSync = async () => {
        setSyncing(true)
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/git-backup/sync`, { body: {} })
            setSuccess(t('git_backup_sync_started'))
            await loadStatus()
        } catch (err: any) {
            setError(err.message || t('git_backup_sync_failed'))
        } finally {
            setSyncing(false)
        }
    }

    const handleSaveBackupSettings = async () => {
        setSavingBackup(true)
        setError(null)
        setSuccess(null)

        try {
            await postJSON(`/project/${projectId}/git-backup/backup/settings`, {
                body: {
                    enabled: backupSettings.enabled,
                    modificationThreshold: backupSettings.modificationThreshold,
                    intervalMinutes: backupSettings.intervalMinutes,
                    maxBackups: backupSettings.maxBackups,
                },
            })
            setSuccess(t('git_backup_settings_saved'))
            await loadBackupSettings()
        } catch (err: any) {
            setError(err.message || t('git_backup_settings_failed'))
        } finally {
            setSavingBackup(false)
        }
    }

    if (loading) {
        return (
            <div className="settings-git-backup" style={{ textAlign: 'center', padding: '16px' }}>
                <Spinner animation="border" size="sm" />
            </div>
        )
    }

    return (
        <div className="settings-git-backup" style={{ padding: '8px 16px' }}>
            <h4 style={{ marginBottom: '8px' }}>{t('git_backup_storage')}</h4>

            {error && <Alert variant="danger" style={{ fontSize: '12px', padding: '8px' }}>{error}</Alert>}
            {success && <Alert variant="success" style={{ fontSize: '12px', padding: '8px' }}>{success}</Alert>}

            {!status.enabled && !showLinkForm && (
                <div>
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setShowLinkForm(true)}
                        disabled={!write}
                        style={{ width: '100%' }}
                    >
                        {t('git_backup_link_project')}
                    </Button>
                </div>
            )}

            {!status.enabled && showLinkForm && (
                <Form>
                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('git_backup_repo_url')}</Form.Label>
                        <Form.Control
                            type="url"
                            size="sm"
                            value={repoUrl}
                            onChange={(e: any) => setRepoUrl(e.target.value)}
                            placeholder="https://github.com/user/repo.git"
                            required
                        />
                    </Form.Group>

                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('git_backup_branch')}</Form.Label>
                        <Form.Control
                            type="text"
                            size="sm"
                            value={branch}
                            onChange={(e: any) => setBranch(e.target.value)}
                            placeholder="main"
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
                        <Form.Label style={{ fontSize: '12px' }}>{t('git_backup_access_token')}</Form.Label>
                        <Form.Control
                            type="password"
                            size="sm"
                            value={accessToken}
                            onChange={(e: any) => setAccessToken(e.target.value)}
                            placeholder="ghp_xxxxxxxxxxxx"
                            required
                        />
                    </Form.Group>

                    <Form.Group className="mb-2">
                        <Form.Label style={{ fontSize: '12px' }}>{t('git_backup_base_path')}</Form.Label>
                        <Form.Control
                            type="text"
                            size="sm"
                            value={basePath}
                            onChange={(e: any) => setBasePath(e.target.value)}
                            placeholder={t('git_backup_base_path_placeholder')}
                        />
                    </Form.Group>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleTestConnection}
                            disabled={testing || !repoUrl || !username || !accessToken}
                            style={{ width: '100%' }}
                        >
                            {testing ? <Spinner animation="border" size="sm" /> : t('test_connection')}
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleLink}
                            disabled={!repoUrl || !username || !accessToken}
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
                        <strong>{t('git_backup_linked')}</strong>
                        <div style={{ marginTop: '4px' }}>
                            <small>
                                <strong>{t('git_backup_repo')}:</strong> {status.repoUrl}
                                <br />
                                <strong>{t('git_backup_branch')}:</strong> {status.branch}
                                {status.basePath && (
                                    <>
                                        <br />
                                        <strong>{t('path')}:</strong> {status.basePath}
                                    </>
                                )}
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

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '16px' }}>
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
                            {t('git_backup_unlink_keep')}
                        </Button>
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleUnlink(true)}
                            disabled={!write}
                            style={{ width: '100%' }}
                        >
                            {t('git_backup_unlink_delete')}
                        </Button>
                    </div>

                    {/* Backup Settings Section */}
                    <div style={{ borderTop: '1px solid #ddd', paddingTop: '12px', marginTop: '8px' }}>
                        <h5 style={{ fontSize: '14px', marginBottom: '8px' }}>{t('git_backup_settings')}</h5>

                        <Form.Group className="mb-2">
                            <Form.Check
                                type="switch"
                                id="git-backup-enabled"
                                label={t('git_backup_enable')}
                                checked={backupSettings.enabled}
                                onChange={(e: any) => setBackupSettings({ ...backupSettings, enabled: e.target.checked })}
                                disabled={!write}
                            />
                        </Form.Group>

                        {backupSettings.enabled && (
                            <>
                                <Form.Group className="mb-2">
                                    <Form.Label style={{ fontSize: '12px' }}>
                                        {t('git_backup_threshold')}
                                        <small className="text-muted" style={{ display: 'block' }}>
                                            {t('git_backup_threshold_help')}
                                        </small>
                                    </Form.Label>
                                    <Form.Control
                                        type="number"
                                        size="sm"
                                        min={1}
                                        value={backupSettings.modificationThreshold}
                                        onChange={(e: any) => setBackupSettings({
                                            ...backupSettings,
                                            modificationThreshold: parseInt(e.target.value) || 6
                                        })}
                                        disabled={!write}
                                    />
                                </Form.Group>

                                <Form.Group className="mb-2">
                                    <Form.Label style={{ fontSize: '12px' }}>
                                        {t('git_backup_interval')}
                                        <small className="text-muted" style={{ display: 'block' }}>
                                            {t('git_backup_interval_help')}
                                        </small>
                                    </Form.Label>
                                    <Form.Control
                                        type="number"
                                        size="sm"
                                        min={1}
                                        value={backupSettings.intervalMinutes}
                                        onChange={(e: any) => setBackupSettings({
                                            ...backupSettings,
                                            intervalMinutes: parseInt(e.target.value) || 10
                                        })}
                                        disabled={!write}
                                    />
                                </Form.Group>

                                <Form.Group className="mb-2">
                                    <Form.Label style={{ fontSize: '12px' }}>
                                        {t('git_backup_max_count')}
                                        <small className="text-muted" style={{ display: 'block' }}>
                                            {t('git_backup_max_count_help')}
                                        </small>
                                    </Form.Label>
                                    <Form.Control
                                        type="number"
                                        size="sm"
                                        min={1}
                                        value={backupSettings.maxBackups}
                                        onChange={(e: any) => setBackupSettings({
                                            ...backupSettings,
                                            maxBackups: parseInt(e.target.value) || 10
                                        })}
                                        disabled={!write}
                                    />
                                </Form.Group>

                                {backupSettings.lastBackupAt && (
                                    <div style={{ fontSize: '12px', marginBottom: '8px' }}>
                                        <small>
                                            <strong>{t('git_backup_last_backup')}:</strong>{' '}
                                            {new Date(backupSettings.lastBackupAt).toLocaleString()}
                                        </small>
                                    </div>
                                )}
                            </>
                        )}

                        <Button
                            variant="primary"
                            size="sm"
                            onClick={handleSaveBackupSettings}
                            disabled={!write || savingBackup}
                            style={{ width: '100%' }}
                        >
                            {savingBackup ? <Spinner animation="border" size="sm" /> : t('save')}
                        </Button>
                    </div>
                </div>
            )}
        </div>
    )
}
