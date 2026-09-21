import { NextRequest } from 'next/server';
import { missingSunoCookieResponse, resolveSunoAuth } from '@/lib/apiAuth';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';
import {
  createUploadFileWork,
  getUploadFileWork,
  runUploadFileWorkflow
} from '@/lib/uploadFileWorkflow';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const workId = url.searchParams.get('work_id');

    if (!workId)
      return jsonResponse({ error: 'Missing query parameter work_id' }, 400);

    const work = await getUploadFileWork(workId);
    if (!work)
      return jsonResponse({ error: `Upload work not found: ${workId}` }, 404);

    return jsonResponse(work);
  } catch (error: any) {
    return errorResponse(error, 'Error reading upload work');
  }
}

/**
 * multipart/form-data:
 *  file (required), title, image_url, workspace_id | workspace_name, create_workspace_if_missing,
 *  audio_content_types (comma separated, e.g. "Song Demo"), reject_copyright_muted,
 *  account (or x-suno-account header) | suno_cookie
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!(file instanceof File))
      return jsonResponse({ error: 'Missing form-data file field' }, 400);

    const auth = resolveSunoAuth(req, formData);
    if (!auth)
      return missingSunoCookieResponse();

    const workspaceId =
      String(formData.get('workspace_id') || '').trim() || undefined;
    const workspaceName =
      String(formData.get('workspace_name') || '').trim() || undefined;
    const title = String(formData.get('title') || '').trim() || undefined;
    const imageUrl = String(formData.get('image_url') || '').trim() || undefined;
    const createWorkspaceIfMissing = parseBoolean(formData.get('create_workspace_if_missing'));
    const rejectCopyrightMuted = parseBoolean(formData.get('reject_copyright_muted'));
    const audioContentTypes = String(formData.get('audio_content_types') || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);
    const fileBuffer = Buffer.from(await file.arrayBuffer());

    const work = await createUploadFileWork({
      filename: file.name,
      content_type: file.type || undefined,
      file_size: file.size,
      workspace_id: workspaceId,
      workspace_name: workspaceName,
      title,
      image_url: imageUrl,
      account_id: auth.accountId,
      create_workspace_if_missing: createWorkspaceIfMissing || undefined,
      audio_content_types: audioContentTypes.length ? audioContentTypes : undefined,
      reject_copyright_muted: rejectCopyrightMuted || undefined
    });

    setImmediate(() => {
      void runUploadFileWorkflow({
        workId: work.work_id,
        sunoCookie: auth.cookie,
        accountId: auth.accountId,
        fileBuffer,
        filename: file.name,
        contentType: file.type || undefined,
        workspaceId,
        workspaceName,
        title,
        imageUrl,
        options: {
          createWorkspaceIfMissing,
          audioContentTypes,
          rejectCopyrightMuted
        }
      });
    });

    const statusUrl = new URL(req.url);
    statusUrl.search = '';
    statusUrl.searchParams.set('work_id', work.work_id);

    return jsonResponse(
      {
        work_id: work.work_id,
        status: work.status,
        status_url: statusUrl.toString(),
        account_id: auth.accountId ?? null
      },
      202
    );
  } catch (error: any) {
    return errorResponse(error, 'Error creating upload work');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
