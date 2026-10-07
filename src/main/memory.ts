import Client, { QueryMemoryListRequest, QueryUserProfileRequest, DeleteMemoryRequest, UpdateMemoryRequest, CreateMemoryRequest } from '@alicloud/sfmmultimodalapp20250909';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import type { MemoryRequest, MemoryResult } from '../shared/memory';

export function memoryConfig(env: Record<string, string | undefined>) {
  if (!env.app_id?.trim() || !env.workspace_id?.trim()) throw new Error('.env 需要 app_id 和 workspace_id');
  if (!env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim() || !env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim()) {
    throw new Error('缺少 ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET；请在 .env 配置 RAM AccessKey。百炼对话 key 和 CLI 控制台登录态不能代替它。');
  }
  return new $OpenApiUtil.Config({
    accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
    securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN || undefined,
    endpoint: 'sfmmultimodalapp.cn-beijing.aliyuncs.com', regionId: 'cn-beijing',
    connectTimeout: 10000, readTimeout: 30000,
  });
}

type MemoryClient = Pick<Client, 'queryMemoryList' | 'queryUserProfile' | 'deleteMemory' | 'updateMemory' | 'createMemory'>;
export async function runMemory(api: MemoryClient, scope: { appId: string; workspaceId: string }, options: MemoryRequest & { user: string }): Promise<MemoryResult> {
  if (!options || !['list', 'profile', 'create', 'update', 'delete'].includes(options.command)) throw new Error('记忆操作无效');
  if (typeof options.user !== 'string' || !options.user.trim() || options.user.length > 36) throw new Error('用户 ID 无效');
  if (['list', 'create'].includes(options.command) && !['observation_project', 'profile_project'].includes(options.project || '')) throw new Error('记忆类型无效');
  if (options.command === 'list' && (!Number.isSafeInteger(options.page) || options.page! < 1)) throw new Error('页码应为正整数');
  if (['update', 'delete'].includes(options.command) && (typeof options.id !== 'string' || !options.id.trim() || options.id === '*')) throw new Error('需要指定一条记忆');
  if (['create', 'update'].includes(options.command) && (typeof options.content !== 'string' || !options.content.trim())) throw new Error('记忆内容不能为空');
  const identity = { ...scope, userDefinedId: options.user };
  let response;
  try {
    switch (options.command) {
      case 'create': response = await api.createMemory(new CreateMemoryRequest({ ...identity, projectId: options.project, content: options.content, autoUpdate: false, expirationTime: -1 })); break;
      case 'list': response = await api.queryMemoryList(new QueryMemoryListRequest({ ...identity, projectId: options.project, pageNumber: options.page, pageSize: 20 })); break;
      case 'profile': response = await api.queryUserProfile(new QueryUserProfileRequest(identity)); break;
      case 'update': response = await api.updateMemory(new UpdateMemoryRequest({ ...identity, memoryNodeId: options.id, content: options.content })); break;
      case 'delete': response = await api.deleteMemory(new DeleteMemoryRequest({ ...identity, memoryNodeId: options.id })); break;
      default: throw new Error('未知命令');
    }
  } catch (error: any) {
    // SDK exceptions may contain signed request URLs. Do not print the raw error.
    throw new Error(`记忆 API 请求失败：${String(error.code || 'NetworkError')}；请检查网络、RAM 权限和百炼工作空间授权。`);
  }
  const body = response.body;
  if (!body || body.success !== true || (body.httpStatusCode !== undefined && body.httpStatusCode >= 400)) {
    throw new Error(`记忆 API 未成功：${body?.code || 'InvalidResponse'}${body?.requestId ? `（requestId: ${body.requestId}）` : ''}`);
  }
  if (options.command === 'delete') return { deleted: options.id, user: options.user, requestId: body.requestId };
  if (options.command === 'update') return { updated: options.id, content: options.content, user: options.user, requestId: body.requestId };
  if (!body.data) throw new Error('记忆 API 返回缺少 data，不能判断是否为空');
  return { user: options.user, ...(options.command === 'list' ? { project: options.project, page: options.page } : {}), data: body.data as MemoryResult['data'] };
}
