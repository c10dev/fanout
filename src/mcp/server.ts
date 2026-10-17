import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { probe as realProbe, type MediaInfo } from '../core/media.ts';
import { accountLabel, appReady, assessMedia, createScheduledPost, previewPost, type TargetPreview } from '../core/posting.ts';
import type { Provider, ProviderContext } from '../core/provider.ts';
import { isTerminal } from '../core/state.ts';
import type { CaptionFile, PostInput, Target, TargetInput } from '../core/types.ts';
import type { Worker } from '../core/worker.ts';
import { defaultAccountName } from '../core/inbox.ts';
import { isShort } from '../providers/youtube.ts';

// Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0.
// Spec: https://modelcontextprotocol.io/specification

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function packageVersion(): string {
  for (const rel of ['../../package.json', '../package.json']) {
    try {
      return (JSON.parse(readFileSync(join(import.meta.dirname, rel), 'utf8')) as { version: string }).version;
    } catch {
      // try the next layout (src/ vs dist/)
    }
  }
  return '0.0.0';
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

class ToolError extends Error {}

const TARGETS_SCHEMA = {
  type: 'array',
  minItems: 1,
  description:
    'Where to post. options per platform — youtube: {privacy: "public"|"unlisted"|"private" (required), madeForKids: boolean (required), categoryId?, playlistId?, notifySubscribers?}; ' +
    'tiktok: {mode: "inbox"|"direct", and for direct: privacyLevel (required, from list_accounts), musicConsent: true (required), allowComment?, allowDuet?, allowStitch?, brandOrganic?, brandedContent?, caption?}; ' +
    'instagram: {caption?, shareToFeed?, thumbOffsetMs?}; facebook: {caption?}; bluesky: {text? (≤300 chars), alt?, langs?}; mastodon: {visibility: "public"|"unlisted"|"private" (required), text?, alt?, language?, spoilerText?}.',
  items: {
    type: 'object',
    required: ['platform'],
    properties: {
      platform: { type: 'string', enum: ['youtube', 'tiktok', 'instagram', 'facebook', 'bluesky', 'mastodon'] },
      account: { type: 'string', description: 'Connected account name; defaults to "main" or the only connected account.' },
      options: { type: 'object' },
    },
  },
};

const POST_SCHEMA = {
  type: 'object',
  required: ['path', 'title', 'targets'],
  properties: {
    path: { type: 'string', description: 'Absolute path of the video file on this machine.' },
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    scheduledAt: { type: 'string', description: 'ISO-8601 time to publish (optional).' },
    aiGenerated: { type: 'boolean', description: 'Realistic AI-generated or altered content (disclosed on YouTube/TikTok).' },
    thumbnailPath: { type: 'string', description: 'JPEG/PNG ≤2MB, YouTube only.' },
    captions: {
      type: 'array',
      description: 'YouTube only.',
      items: { type: 'object', required: ['language', 'path'], properties: { language: { type: 'string' }, path: { type: 'string' } } },
    },
    targets: TARGETS_SCHEMA,
  },
};

const TOOLS = [
  {
    name: 'list_accounts',
    title: 'List connected accounts',
    description: 'Platforms fanout supports, whether each BYO app is set up, and the connected accounts (names to use in targets).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'check_video',
    title: 'Check a video against platform specs',
    description: 'Probe a local video and say per platform whether it uploads as is, needs a transcode first, or cannot be posted.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'preview_post',
    title: 'Preview a post without uploading',
    description:
      'Show exactly which account and visibility each target will use, and every error/warning the upload would hit. ' +
      'Always call this and show the result to the user before create_post.',
    inputSchema: POST_SCHEMA,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'create_post',
    title: 'Upload a video to the chosen platforms',
    description:
      'Queue the post and start uploading in the background; returns the post id. This publishes to real accounts — ' +
      'only call it after the user approved the preview_post result. Track progress with get_post_status.',
    inputSchema: POST_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'get_post_status',
    title: 'Get post status',
    description: 'Per-platform state (queued, uploading, processing, published, handed_off, failed, needs_reauth), URLs, errors and warnings. Without postId, the 10 most recent posts.',
    inputSchema: { type: 'object', properties: { postId: { type: 'string', description: 'Full id or unique prefix.' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'retry_target',
    title: 'Retry a failed target',
    description: 'Queue a failed or needs_reauth target again (after fixing the cause, e.g. reconnecting the account).',
    inputSchema: { type: 'object', required: ['targetId'], properties: { targetId: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

export interface McpDeps {
  ctx: ProviderContext;
  providers: Map<string, Provider>;
  worker?: Worker;
  probe?: (path: string) => Promise<MediaInfo>;
}

export class McpServer {
  readonly #deps: McpDeps;
  readonly #version = packageVersion();

  constructor(deps: McpDeps) {
    this.#deps = deps;
  }

  /** Handle one JSON-RPC message; returns the response, or undefined for notifications. */
  async handle(msg: JsonRpcRequest): Promise<Record<string, unknown> | undefined> {
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') throw { code: -32600, message: 'Invalid Request' };
      const result = await this.#dispatch(msg);
      return isRequest ? { jsonrpc: '2.0', id: msg.id, result } : undefined;
    } catch (err) {
      if (!isRequest) return undefined;
      const e = err as { code?: number; message?: string };
      return { jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? String(err) } };
    }
  }

  async #dispatch(msg: JsonRpcRequest): Promise<unknown> {
    switch (msg.method) {
      case 'initialize': {
        const requested = String(msg.params?.protocolVersion ?? '');
        return {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'fanout', title: 'fanout video uploader', version: this.#version },
          instructions:
            'fanout uploads one local video to YouTube, TikTok, Instagram Reels, Facebook Reels, Bluesky and Mastodon through the user\'s own platform apps. ' +
            'Use preview_post and get the user\'s approval before create_post: posts go to real, often public, accounts.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        return this.#callTool(String(msg.params?.name ?? ''), (msg.params?.arguments ?? {}) as Record<string, unknown>);
      default:
        if (msg.method.startsWith('notifications/')) return undefined;
        throw { code: -32601, message: `Method not found: ${msg.method}` };
    }
  }

  async #callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!TOOLS.some((t) => t.name === name)) throw { code: -32602, message: `Unknown tool: ${name}` };
    try {
      const data = await this.#run(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
    } catch (err) {
      // Tool failures go back to the model as results it can read and act on.
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  async #run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { ctx, providers } = this.#deps;
    const { store } = ctx;
    switch (name) {
      case 'list_accounts': {
        const accounts = store.listAccounts();
        return {
          platforms: [...providers.values()].map((p) => ({
            platform: p.id,
            name: p.displayName,
            appConfigured: appReady(store, p),
            capabilities: p.capabilities,
            accounts: accounts.filter((a) => a.platform === p.id).map((a) => ({ name: a.name, label: accountLabel(a.profile, a.name) })),
          })),
        };
      }
      case 'check_video': {
        const media = await this.#probe(this.#file(args.path, 'path'));
        return { media: { ...media, path: undefined }, youtubeShort: isShort(media), platforms: assessMedia(media, providers.values()) };
      }
      case 'preview_post': {
        const { input, targets, media } = await this.#postArgs(args);
        return { targets: previewPost(store, providers, input, targets, media) };
      }
      case 'create_post': {
        const { input, targets, media } = await this.#postArgs(args);
        const preview = previewPost(store, providers, input, targets, media);
        const blocked = preview.filter((p) => p.errors.length);
        if (blocked.length) throw new ToolError(`올릴 수 없는 대상이 있어 게시하지 않았습니다:\n${blocked.map(describeBlocked).join('\n')}`);
        const { post, targets: created } = createScheduledPost(store, providers, input, targets);
        this.#deps.worker?.tick();
        return { postId: post.id, targets: created.map(publicTarget), next: 'get_post_status 로 진행 상황을 확인하세요' };
      }
      case 'get_post_status': {
        const id = typeof args.postId === 'string' ? args.postId : undefined;
        const posts = id ? [store.findPost(id)].filter((p) => p !== undefined) : store.listPosts(10);
        if (id && !posts.length) throw new ToolError(`게시물 없음: ${id}`);
        return {
          posts: posts.map((p) => ({
            postId: p.id,
            title: p.title,
            createdAt: p.createdAt,
            scheduledAt: p.scheduledAt,
            targets: store.targetsForPost(p.id).map(publicTarget),
          })),
        };
      }
      case 'retry_target': {
        const t = store.getTarget(String(args.targetId ?? ''));
        if (!t) throw new ToolError(`대상 없음: ${String(args.targetId)}`);
        if (t.state !== 'failed' && t.state !== 'needs_reauth') throw new ToolError(`${t.state} 상태는 다시 시도할 수 없습니다`);
        const next = store.transition(t.id, 'queued', { attempts: 0, errorCode: undefined, errorMessage: undefined, notBefore: undefined }, 'retry via MCP');
        this.#deps.worker?.tick();
        return { target: publicTarget(next) };
      }
      default:
        throw new ToolError(`unknown tool ${name}`);
    }
  }

  #file(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new ToolError(`${field}: 파일 경로가 필요합니다`);
    const path = isAbsolute(value) ? value : resolve(value);
    if (!existsSync(path)) throw new ToolError(`${field}: 파일이 없습니다: ${path}`);
    return path;
  }

  async #probe(path: string): Promise<MediaInfo> {
    try {
      return await (this.#deps.probe ?? realProbe)(path);
    } catch (err) {
      throw new ToolError(`영상으로 읽을 수 없습니다: ${(err as Error).message.trim().split('\n').pop()}`);
    }
  }

  async #postArgs(args: Record<string, unknown>): Promise<{ input: PostInput; targets: TargetInput[]; media: MediaInfo }> {
    const mediaPath = this.#file(args.path, 'path');
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) throw new ToolError('title이 필요합니다');
    if (args.scheduledAt !== undefined && Number.isNaN(Date.parse(String(args.scheduledAt)))) throw new ToolError('scheduledAt은 ISO-8601 시각이어야 합니다');
    if (!Array.isArray(args.targets) || !args.targets.length) throw new ToolError('targets가 하나 이상 필요합니다');
    const accounts = this.#deps.ctx.store.listAccounts();
    const targets: TargetInput[] = (args.targets as Array<Record<string, unknown>>).map((t) => {
      const platform = String(t.platform ?? '');
      if (!this.#deps.providers.has(platform)) throw new ToolError(`알 수 없는 플랫폼: ${platform}`);
      const account = typeof t.account === 'string' && t.account ? t.account : defaultAccountName(accounts, platform);
      const options = t.options && typeof t.options === 'object' ? (t.options as Record<string, unknown>) : {};
      return { platform, account, options: platform === 'tiktok' && !options.mode ? { mode: 'inbox', ...options } : options };
    });
    const captions: CaptionFile[] = Array.isArray(args.captions)
      ? (args.captions as Array<Record<string, unknown>>).map((c, i) => ({ language: String(c.language ?? ''), path: this.#file(c.path, `captions[${i}].path`) }))
      : [];
    const input: PostInput = {
      mediaPath,
      title,
      description: typeof args.description === 'string' ? args.description : '',
      tags: Array.isArray(args.tags) ? args.tags.map(String).map((t) => t.trim()).filter(Boolean) : [],
      thumbnailPath: args.thumbnailPath ? this.#file(args.thumbnailPath, 'thumbnailPath') : undefined,
      captions,
      containsSyntheticMedia: Boolean(args.aiGenerated),
      scheduledAt: args.scheduledAt ? new Date(String(args.scheduledAt)).toISOString() : undefined,
    };
    return { input, targets, media: await this.#probe(mediaPath) };
  }
}

function describeBlocked(p: TargetPreview): string {
  return `- ${p.platform}/${p.account}: ${p.errors.join(' / ')}`;
}

function publicTarget(t: Target) {
  return {
    targetId: t.id,
    platform: t.platform,
    account: t.account,
    state: t.state,
    done: isTerminal(t.state),
    url: t.remoteUrl,
    error: t.errorCode ? `${t.errorCode}: ${t.errorMessage ?? ''}` : undefined,
    warnings: t.warnings,
    scheduledFor: t.state === 'queued' ? t.notBefore : undefined,
  };
}

/** Serve MCP over newline-delimited JSON on stdin/stdout. Resolves when input closes. */
export async function serveStdio(server: McpServer, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    // Requests run concurrently (a long check_video must not block ping); responses carry their id.
    const job = server.handle(msg).then((res) => {
      if (res) output.write(`${JSON.stringify(res)}\n`);
    });
    pending.add(job);
    void job.finally(() => pending.delete(job));
  }
  await Promise.all(pending);
}
