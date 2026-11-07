import { stemCatalogue as catalogue } from '@suno-sdk';
import { jsonResponse, optionsResponse } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/** Versioned snapshot of Suno's instrument names, labels, groups and Beta flags. */
export async function GET() {
  return jsonResponse({ ...catalogue, snapshot: true });
}

export async function OPTIONS() { return optionsResponse(); }
