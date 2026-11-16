import { Router } from 'express';

import { asyncHandler } from '@/shared/utils.js';

import { runShellCommand, ShellRunRequestError, type ShellRunResult } from './shell-run.service.js';

export type ShellRunService = {
  run: (body: unknown) => Promise<ShellRunResult>;
};

export function createShellRunRouter(service: ShellRunService = { run: runShellCommand }): Router {
  const router = Router();

  // POST, not GET: this executes something. The command and its working
  // directory are validated in the service, which owns the timeout and the
  // output cap.
  router.post('/run', asyncHandler(async (request, response) => {
    try {
      response.json({ success: true, data: await service.run(request.body ?? {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The shell command could not be started.';
      response.status(error instanceof ShellRunRequestError ? 400 : 500).json({ error: message });
    }
  }));

  return router;
}

export const shellRunRoutes = createShellRunRouter();
