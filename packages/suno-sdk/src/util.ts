export const CLIP_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const parseBoolean = (value: unknown, defaultValue: boolean = false): boolean => {
  if (value === undefined || value === null || value === '')
    return defaultValue;
  if (typeof value === 'boolean')
    return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized))
    return true;
  if (['0', 'false', 'no', 'off'].includes(normalized))
    return false;
  return defaultValue;
};

export const parseOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '')
    return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};
