// Read-only probes: outages, auth and permission errors are never deletion evidence.
export type WorkspaceAvailability = 'available' | 'missing' | 'unknown';
export type WorkspaceRead = (path: string, query: Record<string, string>, signal: AbortSignal) => Promise<Response>;

export async function probeWorkspace(directory: string, read: WorkspaceRead): Promise<WorkspaceAvailability> {
  if (!directory) return 'unknown';
  try {
    const response = await read('/api/fs/directory-stat', { path: directory }, AbortSignal.timeout(5000));
    const body = await response.json();
    if (response.ok && body?.isDirectory === true) return 'available';
    if ((response.status === 404 || response.status === 400) &&
      (body?.reason === 'not-found' || body?.reason === 'not-directory')) return 'missing';
  } catch { /* Preserve workspace selection when the server cannot be reached. */ }
  return 'unknown';
}

export async function verifyRecoveryWorkspace(directory: string, read: WorkspaceRead): Promise<boolean> {
  if (await probeWorkspace(directory, read) !== 'available') return false;
  try {
    const response = await read('/api/location', { 'location[directory]': directory }, AbortSignal.timeout(5000));
    const body = await response.json();
    return response.ok && typeof body?.directory === 'string' &&
      (body.directory.replace(/\/+$/, '') || '/') === (directory.replace(/\/+$/, '') || '/');
  } catch { return false; }
}
