import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ProjectsActionModal from './projects-action-modal'
import ProjectsList from './projects-list'
import Notification from '@/shared/components/notification'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import { unlinkWebDAV } from '../../util/api'
import { Project } from '../../../../../../types/project/dashboard/api'

type DeleteProjectModalProps = Pick<
  React.ComponentProps<typeof ProjectsActionModal>,
  'projects' | 'actionHandler' | 'showModal' | 'handleCloseModal'
>

function DeleteProjectModal({
  projects,
  actionHandler,
  showModal,
  handleCloseModal,
}: DeleteProjectModalProps) {
  const { t } = useTranslation()
  const [projectsToDisplay, setProjectsToDisplay] = useState<typeof projects>(
    []
  )
  const [keepCloudStorage, setKeepCloudStorage] = useState(false)

  // Check if any project has WebDAV enabled
  const hasWebDAVProject = projects.some(
    project => (project as any).webdavConfig?.enabled
  )

  useEffect(() => {
    if (showModal) {
      setProjectsToDisplay(displayProjects => {
        return displayProjects.length ? displayProjects : projects
      })
      setKeepCloudStorage(false)
    } else {
      setProjectsToDisplay([])
    }
  }, [showModal, projects])

  const handleAction = async (project: Project) => {
    if (keepCloudStorage && (project as any).webdavConfig?.enabled) {
      // Call unlink instead of delete
      await unlinkWebDAV(project.id)
    } else {
      // Call the original delete action
      await actionHandler(project)
    }
  }

  return (
    <ProjectsActionModal
      action="delete"
      actionHandler={handleAction}
      title={t('delete_projects')}
      showModal={showModal}
      handleCloseModal={handleCloseModal}
      projects={projects}
    >
      <p>{t('about_to_delete_projects')}</p>
      <ProjectsList projects={projects} projectsToDisplay={projectsToDisplay} />
      {hasWebDAVProject && (
        <div className="mb-3">
          <OLFormCheckbox
            label={t('keep_cloud_storage_content')}
            checked={keepCloudStorage}
            onChange={e => setKeepCloudStorage(e.target.checked)}
          />
        </div>
      )}
      <Notification
        content={t('this_action_cannot_be_undone')}
        type="warning"
      />
    </ProjectsActionModal>
  )
}

export default DeleteProjectModal
