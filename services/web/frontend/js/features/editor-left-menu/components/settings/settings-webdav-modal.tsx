import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from 'react-bootstrap'
import {
    OLModalBody,
    OLModalFooter,
    OLModalHeader,
    OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLForm from '@/shared/components/ol/ol-form'
import Notification from '@/shared/components/notification'
import { postJSON, getUserFacingMessage } from '@/infrastructure/fetch-json'
import useAsync from '@/shared/hooks/use-async'
import { useProjectContext } from '@/shared/context/project-context'

type WebDAVConfig = {
    url: string
    username: string
    password: string
    basePath: string
    enabled?: boolean
}

type Props = {
    show: boolean
    onClose: () => void
    currentConfig?: WebDAVConfig | null
    onSaved?: () => void
}

export default function WebDAVSettingsModal({
    show,
    onClose,
    currentConfig,
    onSaved,
}: Props) {
    const { t } = useTranslation()
    const { _id: projectId } = useProjectContext()
    const { isLoading, isError, error, runAsync } = useAsync()

    const [url, setUrl] = useState(currentConfig?.url || '')
    const [username, setUsername] = useState(currentConfig?.username || '')
    const [password, setPassword] = useState('')
    const [basePath, setBasePath] = useState(currentConfig?.basePath || '/overleaf')

    // Reset form when modal opens with new config
    React.useEffect(() => {
        if (show) {
            setUrl(currentConfig?.url || '')
            setUsername(currentConfig?.username || '')
            setPassword('')
            setBasePath(currentConfig?.basePath || '/overleaf')
        }
    }, [show, currentConfig])

    const handleSubmit = useCallback(
        async (e: React.FormEvent) => {
            e.preventDefault()

            if (!url.trim()) {
                return
            }

            try {
                await runAsync(
                    postJSON(`/project/${projectId}/webdav/link`, {
                        body: {
                            webdavConfig: {
                                url: url.trim(),
                                username: username.trim(),
                                password: password,
                                basePath: basePath.trim() || '/overleaf',
                            },
                        },
                    })
                )
                onSaved?.()
                onClose()
                // Reload page to refresh webdavConfig in project context
                window.location.reload()
            } catch {
                // Error handled by useAsync
            }
        },
        [projectId, url, username, password, basePath, runAsync, onClose, onSaved]
    )

    const handleUnlink = useCallback(async () => {
        try {
            await runAsync(postJSON(`/project/${projectId}/webdav/unlink`, {}))
            onSaved?.()
            onClose()
            // Reload page to refresh webdavConfig in project context
            window.location.reload()
        } catch {
            // Error handled by useAsync
        }
    }, [projectId, runAsync, onClose, onSaved])

    return (
        <Modal show={show} onHide={onClose}>
            <OLModalHeader closeButton>
                <OLModalTitle>{t('cloud_storage_settings')}</OLModalTitle>
            </OLModalHeader>

            <OLModalBody>
                {isError && (
                    <div className="notification-list">
                        <Notification
                            type="error"
                            content={getUserFacingMessage(error) as string}
                        />
                    </div>
                )}

                <OLForm onSubmit={handleSubmit}>
                    <OLFormGroup controlId="webdav-url">
                        <OLFormLabel>{t('webdav_url')}</OLFormLabel>
                        <OLFormControl
                            type="text"
                            placeholder="https://nextcloud.example.com/remote.php/dav/files/username/"
                            value={url}
                            onChange={e => setUrl(e.target.value)}
                            required
                        />
                        <small className="text-muted">
                            {t('webdav_url_hint')}
                        </small>
                    </OLFormGroup>

                    <OLFormGroup controlId="webdav-username">
                        <OLFormLabel>{t('webdav_username')}</OLFormLabel>
                        <OLFormControl
                            type="text"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                        />
                    </OLFormGroup>

                    <OLFormGroup controlId="webdav-password">
                        <OLFormLabel>{t('webdav_password')}</OLFormLabel>
                        <OLFormControl
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder={currentConfig?.url ? t('leave_blank_to_keep_current') : ''}
                        />
                    </OLFormGroup>

                    <OLFormGroup controlId="webdav-base-path">
                        <OLFormLabel>{t('webdav_base_path')}</OLFormLabel>
                        <OLFormControl
                            type="text"
                            value={basePath}
                            onChange={e => setBasePath(e.target.value)}
                            placeholder="/overleaf"
                        />
                        <small className="text-muted">
                            {t('webdav_base_path_hint')}
                        </small>
                    </OLFormGroup>
                </OLForm>
            </OLModalBody>

            <OLModalFooter>
                {currentConfig?.url && (
                    <OLButton
                        variant="danger"
                        onClick={handleUnlink}
                        disabled={isLoading}
                        className="me-auto"
                    >
                        {t('unlink')}
                    </OLButton>
                )}
                <OLButton variant="secondary" onClick={onClose} disabled={isLoading}>
                    {t('cancel')}
                </OLButton>
                <OLButton
                    variant="primary"
                    onClick={handleSubmit}
                    disabled={isLoading || !url.trim()}
                    isLoading={isLoading}
                >
                    {t('save')}
                </OLButton>
            </OLModalFooter>
        </Modal>
    )
}
