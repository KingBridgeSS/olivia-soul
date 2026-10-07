import { readEnvironment } from '../src/main/environment';
import { parseArgs } from 'node:util';
import Client from '@alicloud/sfmmultimodalapp20250909';
import { memoryConfig, runMemory } from '../src/main/memory';
import { MEMORY_USER, type MemoryProject, type MemoryRequest } from '../src/shared/memory';
export { memoryConfig, runMemory } from '../src/main/memory';

const help = `用法：npm run memory -- <命令> [选项]
  list                         查看一页记忆片段（默认第 1 页，每页 20 条）
  profile                      查看用户画像
  create <内容>                新增一条记忆，可用 --project 选择类型
  update <memoryNodeId> <内容>  修改指定记忆，内容有空格时用引号包裹
  delete <memoryNodeId>        删除指定的一条记忆，立即生效
选项：
  --user <id>                  默认 olivia-soul
  --project observation|profile  list/create 的记忆类型，默认 observation
  --page <n>                   list 的页码
  --help                      显示帮助
读取项目 .env 的 app_id、workspace_id 和 ALIBABA_CLOUD_ACCESS_KEY_ID / SECRET。
也可通过同名环境变量配置；环境变量优先。输出为 JSON。`;

export function parseMemoryArgs(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    user: { type: 'string' }, project: { type: 'string' }, page: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return undefined;
  const [command = 'list', target, replacement] = positionals;
  const id = command === 'create' ? undefined : target;
  const content = command === 'create' ? target : replacement;
  if (!['list', 'profile', 'create', 'delete', 'update'].includes(command)) throw new Error('命令应为 list、profile、create、update 或 delete');
  if (positionals.length > (command === 'update' ? 3 : ['delete', 'create'].includes(command) ? 2 : 1)) throw new Error('存在多余参数；修改内容有空格时请用引号包裹');
  if (['delete', 'update'].includes(command) && (!id?.trim() || id === '*')) throw new Error(`${command} 需要指定一个 memoryNodeId，不支持批量操作`);
  if (['create', 'update'].includes(command) && !content?.trim()) throw new Error('新增或修改需要提供非空的记忆内容');
  const user = values.user ?? MEMORY_USER, project = values.project ?? 'observation';
  if (!user.trim() || user.length > 36) throw new Error('用户 ID 应为 1–36 个字符');
  if (!['observation', 'profile'].includes(project)) throw new Error('--project 应为 observation 或 profile');
  if (command !== 'list' && values.page !== undefined) throw new Error('--page 仅用于 list');
  if (!['list', 'create'].includes(command) && values.project !== undefined) throw new Error('--project 仅用于 list 和 create');
  const page = Number(values.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('--page 应为正整数');
  return { command: command as MemoryRequest['command'], id, content, user, project: `${project}_project` as MemoryProject, page };
}


async function main() {
  const env = readEnvironment('.env');
  const args = process.argv.slice(2);
  const explicitUser = args.includes('--user') || args.some(arg => arg.startsWith('--user='));
  const options = parseMemoryArgs(!explicitUser && env.user_id ? [...args, '--user', env.user_id] : args);
  if (!options) { console.log(help); return; }
  const api = new Client(memoryConfig(env));
  console.log(JSON.stringify(await runMemory(api, { appId: env.app_id!, workspaceId: env.workspace_id! }, options), null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
