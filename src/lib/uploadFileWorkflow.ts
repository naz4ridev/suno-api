import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { classifyUploadFailure, sunoApi, SunoUploadError } from '@/lib/SunoApi';

type UploadFileWorkStatus = 'queued' | 'running' | 'completed' | 'failed';
type UploadFileStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

type UploadFileStepKey =
  | 'create_upload'
  | 'upload_storage'
  | 'upload_finish'
  | 'poll_upload'
  | 'initialize_clip'
  | 'set_metadata'
  | 'set_audio_description'
  | 'move_to_workspace';

type UploadFileWorkflowInput = {
  filename: string;
  content_type?: string;
  file_size: number;
  workspace_id?: string;
  workspace_name?: string;
  title?: string;
  image_url?: string;
  /** Account that runs the upload (the cookie itself is never persisted). */
  account_id?: string;
  create_workspace_if_missing?: boolean;
  audio_content_types?: string[];
  reject_copyright_muted?: boolean;
};

type UploadFileOptions = {
  createWorkspaceIfMissing?: boolean;
  audioContentTypes?: string[];
  rejectCopyrightMuted?: boolean;
};

type UploadFileWorkStep = {
  key: UploadFileStepKey;
  label: string;
  status: UploadFileStepStatus;
  started_at?: string;
  finished_at?: string;
  output?: any;
  error?: any;
};

export type UploadFileWork = {
  work_id: string;
  status: UploadFileWorkStatus;
  created_at: string;
  updated_at: string;
  input: UploadFileWorkflowInput;
  steps: UploadFileWorkStep[];
  result?: {
    upload?: any;
    initialized_clip?: any;
    clip?: any;
    workspace_move?: any;
    copyright_muted?: boolean;
    warnings?: string[];
  };
  error?: {
    step: UploadFileStepKey;
    detail: any;
  };
};

type UploadFileQueuedJob = {
  workId: string;
  sunoCookie: string;
  accountId?: string;
  filePath: string;
  filename: string;
  contentType?: string;
  workspaceId?: string;
  workspaceName?: string;
  title?: string;
  imageUrl?: string;
  options?: UploadFileOptions;
};

const resolveWorkDir = () => {
  const configuredDir = process.env.UPLOAD_FILE_WORK_DIR?.trim();
  if (configuredDir)
    return path.resolve(configuredDir);

  return path.resolve(process.cwd(), '.data', 'upload-file-works');
};

const WORK_DIR = resolveWorkDir();
const WORK_FILES_DIR = path.join(WORK_DIR, 'files');

const WORKFLOW_STEPS: Array<Pick<UploadFileWorkStep, 'key' | 'label'>> = [
  { key: 'create_upload', label: 'Create upload task' },
  { key: 'upload_storage', label: 'Upload file to storage' },
  { key: 'upload_finish', label: 'Finalize upload' },
  { key: 'poll_upload', label: 'Wait for Suno upload processing' },
  { key: 'initialize_clip', label: 'Initialize clip in account' },
  { key: 'set_metadata', label: 'Set clip metadata' },
  { key: 'set_audio_description', label: 'Accept inferred description (optional)' },
  { key: 'move_to_workspace', label: 'Move clip to workspace' }
];

const nowIso = () => new Date().toISOString();

const queueState = global as typeof global & {
  __sunoUploadFileQueue?: {
    jobs: Map<string, UploadFileQueuedJob>;
    processing: boolean;
    recoveryPromise?: Promise<void>;
  };
};

const uploadQueue =
  queueState.__sunoUploadFileQueue ||
  {
    jobs: new Map<string, UploadFileQueuedJob>(),
    processing: false,
    recoveryPromise: undefined
  };

queueState.__sunoUploadFileQueue = uploadQueue;

const getWorkPath = (workId: string) =>
  path.join(WORK_DIR, `${workId}.json`);

async function ensureWorkDir() {
  await fs.mkdir(WORK_DIR, { recursive: true });
  await fs.mkdir(WORK_FILES_DIR, { recursive: true });
}

async function saveWork(work: UploadFileWork) {
  await ensureWorkDir();

  const workPath = getWorkPath(work.work_id);
  const tempPath = `${workPath}.${randomUUID()}.tmp`;

  await fs.writeFile(tempPath, JSON.stringify(work, null, 2), 'utf8');
  await fs.rename(tempPath, workPath);
}

export async function getUploadFileWork(
  workId: string
): Promise<UploadFileWork | null> {
  try {
    const raw = await fs.readFile(getWorkPath(workId), 'utf8');
    return JSON.parse(raw) as UploadFileWork;
  } catch (error: any) {
    if (error?.code === 'ENOENT')
      return null;

    throw error;
  }
}

async function updateWork(
  workId: string,
  updater: (work: UploadFileWork) => void
): Promise<UploadFileWork> {
  const work = await getUploadFileWork(workId);
  if (!work)
    throw new Error(`Upload work not found: ${workId}`);

  updater(work);
  work.updated_at = nowIso();
  await saveWork(work);
  return work;
}

function buildErrorDetail(error: any) {
  const detail: Record<string, any> = {
    message: error?.message || 'Unknown error',
    status: error?.status || error?.response?.status,
    data: error?.response?.data,
    detail: error?.detail
  };
  if (error instanceof SunoUploadError) {
    detail.error_type = error.error_type;
    detail.category = error.category;
    detail.retryable = error.retryable;
    detail.copyright = error.copyright;
  }
  return detail;
}

/** Presigned S3 fields (policy/signature) are useless after upload and should not be persisted. */
function redactUploadTask(task: any) {
  if (!task || typeof task !== 'object')
    return task;
  const sensitive = new Set(['policy', 'signature', 'awsaccesskeyid', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token']);
  const fields = task.fields && typeof task.fields === 'object'
    ? Object.fromEntries(
      Object.entries(task.fields).map(([key, value]) =>
        [key, sensitive.has(key.toLowerCase()) ? '[redacted]' : value]
      )
    )
    : task.fields;
  return { ...task, fields };
}

async function markStepStatus(
  workId: string,
  stepKey: UploadFileStepKey,
  status: UploadFileStepStatus,
  options: {
    output?: any;
    error?: any;
  } = {}
) {
  await updateWork(workId, work => {
    const step = work.steps.find(item => item.key === stepKey);
    if (!step)
      throw new Error(`Upload work step not found: ${stepKey}`);

    if (status === 'running' && !step.started_at)
      step.started_at = nowIso();

    if (status === 'completed' || status === 'failed' || status === 'skipped')
      step.finished_at = nowIso();

    step.status = status;

    if (options.output !== undefined)
      step.output = options.output;

    if (options.error !== undefined)
      step.error = options.error;
  });
}

async function setWorkState(
  workId: string,
  status: UploadFileWorkStatus,
  fields: Partial<UploadFileWork> = {}
) {
  await updateWork(workId, work => {
    work.status = status;
    Object.assign(work, fields);
  });
}

export async function createUploadFileWork(
  input: UploadFileWorkflowInput
): Promise<UploadFileWork> {
  const work: UploadFileWork = {
    work_id: randomUUID(),
    status: 'queued',
    created_at: nowIso(),
    updated_at: nowIso(),
    input,
    steps: WORKFLOW_STEPS.map(step => ({
      ...step,
      status: 'pending'
    }))
  };

  await saveWork(work);
  return work;
}

async function markInterruptedWorks() {
  await ensureWorkDir();

  const entries = await fs.readdir(WORK_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json'))
      continue;

    const workId = entry.name.replace(/\.json$/, '');
    const work = await getUploadFileWork(workId);
    if (!work || (work.status !== 'queued' && work.status !== 'running'))
      continue;

    const runningStep =
      work.steps.find(step => step.status === 'running') ||
      work.steps.find(step => step.status === 'pending');

    work.status = 'failed';
    work.updated_at = nowIso();
    work.error = {
      step: runningStep?.key || 'create_upload',
      detail: {
        message: 'Upload work interrupted by process restart before completion'
      }
    };

    for (const step of work.steps) {
      if (step.status === 'running') {
        step.status = 'failed';
        step.finished_at = nowIso();
        step.error = {
          message: 'Upload work interrupted by process restart'
        };
      } else if (step.status === 'pending') {
        step.status = 'skipped';
        step.finished_at = nowIso();
        step.output = {
          skipped: true,
          reason: 'Upload work interrupted by process restart'
        };
      }
    }

    await saveWork(work);
  }
}

async function ensureRecovery() {
  if (!uploadQueue.recoveryPromise) {
    uploadQueue.recoveryPromise = markInterruptedWorks().catch(error => {
      console.error('Error recovering interrupted upload works:', error);
    });
  }

  await uploadQueue.recoveryPromise;
}

async function runTrackedStep<T>(
  workId: string,
  stepKey: UploadFileStepKey,
  action: () => Promise<T>,
  toOutput: (output: T) => any = output => output
): Promise<T> {
  await markStepStatus(workId, stepKey, 'running');

  try {
    const output = await action();
    await markStepStatus(workId, stepKey, 'completed', { output: toOutput(output) });
    return output;
  } catch (error: any) {
    await markStepStatus(workId, stepKey, 'failed', {
      error: buildErrorDetail(error)
    });
    throw error;
  }
}

export async function runUploadFileWorkflow({
  workId,
  sunoCookie,
  accountId,
  fileBuffer,
  filename,
  contentType,
  workspaceId,
  workspaceName,
  title,
  imageUrl,
  options = {}
}: {
  workId: string;
  sunoCookie: string;
  accountId?: string;
  fileBuffer: Buffer;
  filename: string;
  contentType?: string;
  workspaceId?: string;
  workspaceName?: string;
  title?: string;
  imageUrl?: string;
  options?: UploadFileOptions;
}) {
  await setWorkState(workId, 'running');

  let failedStep: UploadFileStepKey = 'create_upload';
  const warnings: string[] = [];

  try {
    const api = await sunoApi(sunoCookie, accountId);
    const extension = api.resolveAudioUploadExtension(filename, contentType);

    failedStep = 'create_upload';
    const uploadTask = await runTrackedStep(workId, 'create_upload', () =>
      api.createAudioUpload(extension, 'file_upload'),
      redactUploadTask
    );

    failedStep = 'upload_storage';
    await runTrackedStep(workId, 'upload_storage', () =>
      api.uploadAudioToStorage(uploadTask, fileBuffer, filename, contentType)
    );

    failedStep = 'upload_finish';
    await runTrackedStep(workId, 'upload_finish', () =>
      api.finishAudioUpload(uploadTask.id, filename, {
        upload_type: 'file_upload',
        agreed_to_vip_upload_terms: false
      })
    );

    failedStep = 'poll_upload';
    await markStepStatus(workId, 'poll_upload', 'running', {
      output: { attempts: [] }
    });

    const attempts: any[] = [];
    const startedAt = Date.now();
    let uploadResult = await api.getUploadedAudio(uploadTask.id);

    try {
      while (true) {
        attempts.push(uploadResult);
        await markStepStatus(workId, 'poll_upload', 'running', {
          output: {
            attempts,
            latest: uploadResult
          }
        });

        if (uploadResult.status === 'complete') {
          await markStepStatus(workId, 'poll_upload', 'completed', {
            output: {
              attempts,
              latest: uploadResult
            }
          });
          break;
        }

        if (uploadResult.status === 'error')
          throw classifyUploadFailure(uploadResult.error_type, uploadResult.error_message, undefined, uploadResult);

        // The web app gives up after 5 minutes of processing.
        if (Date.now() - startedAt > 300000) {
          throw new SunoUploadError({
            message: 'Timed out waiting for Suno to finish processing the upload',
            category: 'timeout',
            retryable: true,
            copyright: false,
            detail: uploadResult
          });
        }

        await new Promise(resolve => setTimeout(resolve, 4000));
        await api.keepAlive(true);
        uploadResult = await api.getUploadedAudio(uploadTask.id);
      }
    } catch (error: any) {
      await markStepStatus(workId, 'poll_upload', 'failed', {
        output: {
          attempts,
          latest: uploadResult
        },
        error: buildErrorDetail(error)
      });
      throw error;
    }

    const copyrightMuted = Boolean(uploadResult.copyright_muted);
    if (copyrightMuted) {
      if (options.rejectCopyrightMuted) {
        failedStep = 'initialize_clip';
        const mutedError = classifyUploadFailure(
          'upload_copyright_muted',
          'copyright: Suno muted the copyrighted parts of this upload (reject_copyright_muted=true)',
          undefined,
          uploadResult
        );
        await markStepStatus(workId, 'initialize_clip', 'failed', { error: buildErrorDetail(mutedError) });
        throw mutedError;
      }
      warnings.push('copyright_muted: Suno muted the parts of this upload detected as copyrighted material');
    }

    failedStep = 'initialize_clip';
    const initializedClip = await runTrackedStep(workId, 'initialize_clip', () =>
      api.initializeUploadClip(uploadTask.id, {})
    );

    const metadataPayload = {
      title: title || uploadResult.title,
      image_url: imageUrl || uploadResult.image_url,
      is_audio_upload_tos_accepted: true
    };

    failedStep = 'set_metadata';
    await runTrackedStep(workId, 'set_metadata', () =>
      api.setClipMetadata(initializedClip.clip_id, metadataPayload)
    );

    // The web app only sends this when the user reviews the inferred description: failures are not fatal.
    failedStep = 'set_audio_description';
    let clipResult: any;
    await markStepStatus(workId, 'set_audio_description', 'running');
    try {
      const descriptionPayload: Record<string, any> = { gemini_description_accepted: true };
      if (options.audioContentTypes?.length)
        descriptionPayload.audio_content_types = options.audioContentTypes;
      clipResult = await api.acceptAudioDescription(initializedClip.clip_id, descriptionPayload);
      await markStepStatus(workId, 'set_audio_description', 'completed', { output: clipResult });
    } catch (error: any) {
      warnings.push(`set_audio_description failed: ${error?.message || error}`);
      await markStepStatus(workId, 'set_audio_description', 'skipped', {
        output: { skipped: true, reason: 'set_audio_description failed (non fatal)' },
        error: buildErrorDetail(error)
      });
      clipResult = await api.getClip(initializedClip.clip_id).catch(() => ({ id: initializedClip.clip_id }));
    }

    let workspaceMove: any = null;
    if (workspaceId || workspaceName) {
      failedStep = 'move_to_workspace';
      workspaceMove = await runTrackedStep(workId, 'move_to_workspace', () =>
        api.moveClipsToWorkspace(
          [initializedClip.clip_id],
          workspaceId,
          workspaceName,
          Boolean(options.createWorkspaceIfMissing)
        )
      );
    } else {
      await markStepStatus(workId, 'move_to_workspace', 'skipped', {
        output: {
          skipped: true,
          reason: 'No workspace_id or workspace_name provided'
        }
      });
    }

    await setWorkState(workId, 'completed', {
      result: {
        upload: uploadResult,
        initialized_clip: initializedClip,
        clip: clipResult,
        workspace_move: workspaceMove,
        copyright_muted: copyrightMuted,
        ...(warnings.length ? { warnings } : {})
      }
    });
  } catch (error: any) {
    await setWorkState(workId, 'failed', {
      error: {
        step: failedStep,
        detail: buildErrorDetail(error)
      }
    });
  }
}

async function processUploadFileQueue() {
  if (uploadQueue.processing)
    return;

  uploadQueue.processing = true;

  try {
    await ensureRecovery();

    while (uploadQueue.jobs.size > 0) {
      const nextEntry = uploadQueue.jobs.entries().next().value as
        | [string, UploadFileQueuedJob]
        | undefined;
      if (!nextEntry)
        break;

      const [workId, job] = nextEntry;
      uploadQueue.jobs.delete(workId);

      try {
        const fileBuffer = await fs.readFile(job.filePath);
        await runUploadFileWorkflow({
          workId: job.workId,
          sunoCookie: job.sunoCookie,
          accountId: job.accountId,
          options: job.options,
          fileBuffer,
          filename: job.filename,
          contentType: job.contentType,
          workspaceId: job.workspaceId,
          workspaceName: job.workspaceName,
          title: job.title,
          imageUrl: job.imageUrl
        });
      } catch (error: any) {
        await setWorkState(job.workId, 'failed', {
          error: {
            step: 'upload_storage',
            detail: buildErrorDetail(error)
          }
        });
      } finally {
        await fs.rm(job.filePath, { force: true }).catch(() => undefined);
      }
    }
  } finally {
    uploadQueue.processing = false;

    if (uploadQueue.jobs.size > 0)
      void processUploadFileQueue();
  }
}

export async function enqueueUploadFileWork(job: {
  workId: string;
  sunoCookie: string;
  accountId?: string;
  options?: UploadFileOptions;
  fileBuffer: Buffer;
  filename: string;
  contentType?: string;
  workspaceId?: string;
  workspaceName?: string;
  title?: string;
  imageUrl?: string;
}) {
  await ensureRecovery();
  await ensureWorkDir();

  const filePath = path.join(job.workId.startsWith('.') ? WORK_FILES_DIR : WORK_FILES_DIR, `${job.workId}-${job.filename}`);
  await fs.writeFile(filePath, job.fileBuffer);

  uploadQueue.jobs.set(job.workId, {
    workId: job.workId,
    sunoCookie: job.sunoCookie,
    accountId: job.accountId,
    options: job.options,
    filePath,
    filename: job.filename,
    contentType: job.contentType,
    workspaceId: job.workspaceId,
    workspaceName: job.workspaceName,
    title: job.title,
    imageUrl: job.imageUrl
  });

  void processUploadFileQueue();
}
