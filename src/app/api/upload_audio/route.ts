import { NextRequest } from 'next/server';
import { AudioUploadType } from '@/lib/SunoApi';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean } from '@/lib/utils';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const validUploadTypes: AudioUploadType[] = ['file_upload', 'voice_recording'];

/**
 * Low level upload (create -> S3 -> upload-finish -> poll). It does not create the clip:
 * use /api/uploads/audio/{id}/initialize-clip or /api/upload_file for the full flow.
 * form-data: file, wait_audio (default true), upload_type (file_upload | voice_recording), account
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!(file instanceof File))
      return jsonResponse({ error: 'Missing form-data file field' }, 400);

    const uploadType = (String(formData.get('upload_type') || 'file_upload')) as AudioUploadType;
    if (!validUploadTypes.includes(uploadType))
      return jsonResponse({ error: `upload_type must be one of: ${validUploadTypes.join(', ')}` }, 400);

    const client = await getClient(req, formData);
    if (client instanceof Response)
      return client;

    const uploadedAudio = await client.api.uploadAudio(
      Buffer.from(await file.arrayBuffer()),
      file.name,
      file.type || undefined,
      parseBoolean(formData.get('wait_audio'), true),
      uploadType
    );

    return jsonResponse(uploadedAudio);
  } catch (error: any) {
    return errorResponse(error, 'Error uploading audio');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
