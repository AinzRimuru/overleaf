# WebDAV Frontend Integration

This document describes the WebDAV frontend integration implementation for Overleaf.

## Overview

The WebDAV frontend integration allows users to:
1. Configure WebDAV cloud storage when creating new projects
2. Link existing projects to WebDAV cloud storage
3. Unlink WebDAV storage without deleting cloud content
4. Fully delete projects including cloud content

## Architecture

### Backend Components

#### 1. Data Model (Project.mjs)
Added `webdavConfig` field to the Project schema:
```javascript
webdavConfig: {
  url: { type: String },           // WebDAV server URL
  username: { type: String },       // Authentication username
  password: { type: String },       // Encrypted password
  basePath: { type: String, default: '/overleaf' }, // Base path for storage
  enabled: { type: Boolean, default: false },       // Enable/disable flag
  lastSyncDate: { type: Date },     // Last synchronization timestamp
}
```

#### 2. Controller Methods (ProjectController.mjs)
- `newProject`: Extended to accept optional `webdavConfig` in request body
- `linkWebDAV`: POST /project/:id/webdav/link - Links existing project to WebDAV
- `unlinkWebDAV`: POST /project/:id/webdav/unlink - Disconnects WebDAV link

#### 3. Update Handler (ProjectUpdateHandler.mjs)
- `setWebDAVConfig(projectId, webdavConfig)`: Sets WebDAV configuration
- `unsetWebDAVConfig(projectId)`: Removes WebDAV configuration (including sensitive data)

#### 4. Validation
Uses Zod schema validation for WebDAV configuration:
- URL: Valid URL format, max 500 characters
- Username: Max 200 characters
- Password: Min 1 character, max 200 characters
- Base path: Max 200 characters, defaults to '/overleaf'

### Frontend Components

#### 1. New Project Form (modal-content-new-project-form.tsx)
- Collapsible "Cloud Storage (Optional)" section
- Fields for URL, username, password, and base path
- WebDAV config sent with project creation if URL is provided

#### 2. Delete Project Modal (delete-project-modal.tsx)
- Shows checkbox "Keep cloud storage content" if project has WebDAV enabled
- Calls `unlinkWebDAV` instead of `deleteProject` when checked
- Preserves cloud content while removing project from Overleaf

#### 3. Link WebDAV Modal (link-webdav-modal.tsx)
- Standalone modal for linking existing projects to WebDAV
- Input validation and error handling
- Internationalized error messages

#### 4. API Functions (api.ts)
```typescript
linkWebDAV(projectId: string, webdavConfig: {...}): Promise<void>
unlinkWebDAV(projectId: string): Promise<void>
```

### Type Definitions

Updated `ProjectApi` type to include optional `webdavConfig`:
```typescript
webdavConfig?: {
  url: string
  username: string
  basePath: string
  enabled: boolean
  lastSyncDate?: Date
}
```

Note: Password is intentionally excluded from the frontend type for security.

## Security Considerations

### Current Implementation
1. **Transport Security**: All credentials transmitted over HTTPS
2. **Input Validation**: 
   - URL format validation
   - Length limits on all fields
   - Required password field
3. **Data Cleanup**: `$unset` operator removes entire webdavConfig on unlink
4. **Audit Logging**: All link/unlink operations are logged

### Future Enhancements
1. **Password Encryption**: Backend should encrypt passwords before storing in MongoDB
2. **Credential Testing**: Add connection test before saving configuration
3. **Token-based Auth**: Consider OAuth/token-based authentication where supported
4. **Field-level Encryption**: Use MongoDB field-level encryption for sensitive fields
5. **Password Rotation**: Implement password change/rotation functionality

## API Endpoints

### Create Project with WebDAV
```
POST /project/new
Body: {
  projectName: string,
  template?: string,
  webdavConfig?: {
    url: string,
    username: string,
    password: string,
    basePath?: string
  }
}
```

### Link Project to WebDAV
```
POST /project/:Project_id/webdav/link
Body: {
  webdavConfig: {
    url: string,
    username: string,
    password: string,
    basePath?: string
  }
}
```

### Unlink WebDAV
```
POST /project/:Project_id/webdav/unlink
```

## Localization

Added translation keys in `en.json`:
- `cloud_storage_optional`: "Cloud Storage (Optional)"
- `webdav_url`: "WebDAV URL"
- `webdav_username`: "Username"
- `webdav_password`: "Password"
- `webdav_base_path`: "Base Path"
- `webdav_url_required`: "WebDAV URL is required"
- `keep_cloud_storage_content`: "Keep cloud storage content (only disconnect link)"
- `link_to_webdav`: "Link to WebDAV Cloud Storage"
- `webdav_connection_test`: "Test Connection"
- `webdav_connection_success`: "Connection successful"
- `webdav_connection_failed`: "Connection failed"

## Testing

### Manual Testing
1. Create new project with WebDAV configuration
2. Verify project is created and WebDAV config is saved
3. Link existing project to WebDAV
4. Delete project with "keep cloud storage" option
5. Verify project is removed but WebDAV content remains
6. Delete project without "keep" option
7. Verify project and WebDAV content are removed

### Unit Tests (To Be Added)
- Test WebDAV config validation
- Test new project form with/without WebDAV config
- Test delete modal checkbox behavior
- Test link modal validation

## Integration with WebDAV Persistor

This frontend integration works with the existing WebDAV persistor backend:
- Located at: `libraries/object-persistor/src/WebDAVPersistor.js`
- Handles actual WebDAV protocol communication
- Manages file uploads/downloads
- Implements MD5 verification

## Known Limitations

1. **Password Security**: Passwords are stored in MongoDB (should be encrypted)
2. **Connection Testing**: No real-time connection validation in UI
3. **Sync Status**: No UI indicator for sync status
4. **Conflict Resolution**: No automated conflict resolution for concurrent edits
5. **Bandwidth**: No bandwidth/quota management

## Future Improvements

1. Add real-time sync status indicator
2. Implement connection test button
3. Add WebDAV settings page in project settings
4. Support multiple WebDAV configurations
5. Add sync conflict resolution UI
6. Implement selective sync (sync only certain folders)
7. Add sync logs/history view
8. Support WebDAV discovery (RFC 4918)

## References

- WebDAV RFC 4918: https://tools.ietf.org/html/rfc4918
- WebDAV Persistor Backend: `libraries/object-persistor/src/WebDAVPersistor.js`
- Project Model: `services/web/app/src/models/Project.mjs`
