import { NextRequest } from 'next/server';
import { getClient } from '@/lib/routeHelpers';
import { errorResponse, jsonResponse, optionsResponse, parseBoolean, parseOptionalNumber } from '@/lib/utils';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/**
 * GET /api/voices?page=1 -> the account voices (personas with persona_type "vox").
 * Use a voice with `persona_id` (or `voice_id`) in /api/custom_generate, /api/generate or /api/generate_from_audio.
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get('page') || '1') || 1;
    const client = await getClient(req);
    if (client instanceof Response)
      return client;

    const data = await client.api.listPersonas(page, 'mine');
    const personas: any[] = data?.personas || [];
    const includeAll = parseBoolean(url.searchParams.get('all'));
    return jsonResponse({
      ...data,
      personas: includeAll ? personas : personas.filter(persona => persona.persona_type === 'vox')
    });
  } catch (error: any) {
    return errorResponse(error, 'Error listing voices');
  }
}

/**
 * POST /api/voices (multipart/form-data) -> creates a voice like the web "Create voice" flow.
 *  voice_file (required): recording of the singer (10-240s recorded / 10-900s uploaded)
 *  verification_file (required): the same singer saying the phrase from GET /api/voices/phrase
 *  phrase_id (required), name (required), description, vocal_start_s, vocal_end_s,
 *  image_s3_id | image_prompt, is_public, user_input_styles, singer_skill_level, account
 * Returns 422 with the verification result when Suno rejects it (e.g. voices_sound_different).
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const voiceFile = formData.get('voice_file');
    const verificationFile = formData.get('verification_file');
    const phraseId = String(formData.get('phrase_id') || '').trim();
    const name = String(formData.get('name') || '').trim();

    if (!(voiceFile instanceof File))
      return jsonResponse({ error: 'voice_file is required' }, 400);
    if (!(verificationFile instanceof File))
      return jsonResponse({ error: 'verification_file is required' }, 400);
    if (!phraseId)
      return jsonResponse({ error: 'phrase_id is required (GET /api/voices/phrase)' }, 400);
    if (!name)
      return jsonResponse({ error: 'name is required' }, 400);

    const client = await getClient(req, formData);
    if (client instanceof Response)
      return client;

    const text = (key: string) => {
      const value = formData.get(key);
      return typeof value === 'string' && value.trim() ? value.trim() : undefined;
    };

    const result = await client.api.createVoice({
      voice: {
        buffer: Buffer.from(await voiceFile.arrayBuffer()),
        filename: voiceFile.name || 'voice.wav',
        contentType: voiceFile.type || undefined
      },
      verification: {
        buffer: Buffer.from(await verificationFile.arrayBuffer()),
        filename: verificationFile.name || 'verification.wav',
        contentType: verificationFile.type || undefined
      },
      phrase_id: phraseId,
      name,
      description: text('description'),
      vocal_start_s: parseOptionalNumber(formData.get('vocal_start_s')),
      vocal_end_s: parseOptionalNumber(formData.get('vocal_end_s')),
      is_public: parseBoolean(formData.get('is_public')),
      image_s3_id: text('image_s3_id'),
      image_prompt: text('image_prompt'),
      user_input_styles: text('user_input_styles'),
      singer_skill_level: text('singer_skill_level')
    });

    return jsonResponse(result, 201);
  } catch (error: any) {
    return errorResponse(error, 'Error creating voice');
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
