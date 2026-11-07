import path from 'node:path';
import { createUploadFileWorkflow, type UploadFileWork, type UploadFileWorkflow } from '@suno-sdk';
import { sunoApi } from '@/lib/SunoApi';

/**
 * Durable upload works (packages/suno-sdk). Records live in UPLOAD_FILE_WORK_DIR
 * (default ./.data/upload-file-works); the workflow itself is the SDK's.
 */
const resolveWorkDir = () => {
  const configuredDir = process.env.UPLOAD_FILE_WORK_DIR?.trim();
  return configuredDir ? path.resolve(configuredDir) : path.resolve(process.cwd(), '.data', 'upload-file-works');
};

// Kept on `global` so Next.js dev reloads do not start a second queue over the same directory.
const globalForWorkflow = global as unknown as { sunoUploadWorkflow?: UploadFileWorkflow };
export const uploadFileWorkflow = globalForWorkflow.sunoUploadWorkflow ||= createUploadFileWorkflow({
  storageDirectory: resolveWorkDir(),
  getApi: (cookie, accountId) => sunoApi(cookie, accountId)
});

export const { getUploadFileWork, createUploadFileWork, runUploadFileWorkflow, enqueueUploadFileWork, submitUploadFile } = uploadFileWorkflow;
export type { UploadFileWork };
