import { Router, type Request, type Response } from 'express';

import { asyncHandler, routeParam } from '@/shared/utils.js';

import type { McpScope } from './mcp.config.js';
import { mcpService, type McpService } from './mcp.service.js';

function scopeFrom(value: unknown, fallback: McpScope = 'global'): McpScope | 'all' | null {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'global' || value === 'project') return value;
  if (value === 'all') return 'all';
  return null;
}

function projectPath(request: Request): string | undefined {
  const value = request.query.projectPath ?? (request.body as Record<string, unknown> | undefined)?.projectPath;
  return typeof value === 'string' && value ? value : undefined;
}

function fail(response: Response, error: unknown): Response {
  const message = error instanceof Error ? error.message : 'MCP request failed.';
  const status = /not found/iu.test(message) ? 404
    : /already exists/iu.test(message) ? 409
      : /requires|needs|must be|invalid|absolute path/iu.test(message) ? 400
        : 500;
  return response.status(status).json({ success: false, error: { message } });
}

export function createMcpRouter(service: McpService = mcpService): Router {
  const router = Router();

  router.get('/servers', asyncHandler(async (request, response) => {
    try {
      const scope = scopeFrom(request.query.scope);
      if (!scope) return response.status(400).json({ success: false, error: { message: 'scope must be global, project or all.' } });
      response.json({ success: true, data: await service.list(scope, projectPath(request)) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.get('/servers/:name', asyncHandler(async (request, response) => {
    try {
      const scope = scopeFrom(request.query.scope);
      if (!scope || scope === 'all') return response.status(400).json({ success: false, error: { message: 'scope must be global or project.' } });
      const server = await service.get(scope, routeParam(request.params.name), projectPath(request));
      if (!server) return response.status(404).json({ success: false, error: { message: 'MCP server was not found.' } });
      response.json({ success: true, data: server });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/servers', asyncHandler(async (request, response) => {
    try {
      response.status(201).json({ success: true, data: await service.add(request.body) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.patch('/servers/:name', asyncHandler(async (request, response) => {
    try {
      const scope = scopeFrom(request.query.scope ?? request.body?.scope);
      if (!scope || scope === 'all') return response.status(400).json({ success: false, error: { message: 'scope must be global or project.' } });
      response.json({
        success: true,
        data: await service.update(scope, routeParam(request.params.name), (request.body ?? {}) as Record<string, unknown>, projectPath(request)),
      });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.delete('/servers/:name', asyncHandler(async (request, response) => {
    try {
      const scope = scopeFrom(request.query.scope);
      if (!scope || scope === 'all') return response.status(400).json({ success: false, error: { message: 'scope must be global or project.' } });
      await service.remove(scope, routeParam(request.params.name), projectPath(request));
      response.status(204).end();
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/servers/:name/verify', asyncHandler(async (request, response) => {
    try {
      const scope = scopeFrom(request.query.scope ?? request.body?.scope);
      if (!scope || scope === 'all') return response.status(400).json({ success: false, error: { message: 'scope must be global or project.' } });
      response.json({
        success: true,
        data: await service.verify(scope, routeParam(request.params.name), projectPath(request)),
      });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.get('/catalog', asyncHandler(async (request, response) => {
    try {
      const source = request.query.source;
      if (source !== undefined && source !== 'bundled' && source !== 'overlay' && source !== 'registry') {
        return response.status(400).json({ success: false, error: { message: 'source must be bundled, overlay or registry.' } });
      }
      const sort = request.query.sort;
      if (sort !== undefined && sort !== 'name' && sort !== 'relevance' && sort !== 'popularity') {
        return response.status(400).json({ success: false, error: { message: 'sort must be name, relevance or popularity.' } });
      }
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      response.json({
        success: true,
        data: await service.catalog({
          ...(typeof request.query.q === 'string' ? { q: request.query.q } : {}),
          ...(typeof source === 'string' ? { source } : {}),
          ...(typeof sort === 'string' ? { sort } : {}),
          ...(typeof request.query.cursor === 'string' ? { cursor: request.query.cursor } : {}),
          ...(limit === undefined || !Number.isFinite(limit) ? {} : { limit }),
        }),
      });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.get('/status', asyncHandler(async (request, response) => {
    try {
      response.json({ success: true, data: await service.status(projectPath(request)) });
    } catch (error) {
      fail(response, error);
    }
  }));

  router.post('/servers/:name/pin', asyncHandler(async (request, response) => {
    try {
      const scope = scopeFrom(request.query.scope ?? request.body?.scope);
      if (!scope || scope === 'all') return response.status(400).json({ success: false, error: { message: 'scope must be global or project.' } });
      response.json({
        success: true,
        data: await service.pin(scope, routeParam(request.params.name), request.body?.version ?? null, projectPath(request)),
      });
    } catch (error) {
      fail(response, error);
    }
  }));

  return router;
}

export default createMcpRouter();
