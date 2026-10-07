const execConfig = { commandConfig: { issuerConfig: { replyMode: 'ON_EXECUTION_RESULT' } } };
export const taskTools = [
  {
    name: 'take_screenshot',
    description: '查看当前主屏幕。用户要求查看屏幕，或回答需要当前画面时调用；普通聊天、已有足够信息或用户禁止查看时不调用。仅截图，不操作电脑，不创建后台任务。',
    params: [],
    fewShotList: [
      { query: '看看我现在屏幕上是什么', parameters: {} },
      { query: '屏幕上这个报错是什么意思？', parameters: {} },
      { query: '我切了页面，再看看', parameters: {} }
    ], execConfig
  },
  {
    name: 'computer_task',
    description: '仅执行用户明确要求的电脑、文件或应用操作。个人信息、偏好、经历、安排的“记住/记一下/别忘了”不是电脑任务，禁止调用。如“下周二快手agent面试，请记住”“记一下周五答辩”只聊天，由云端记忆处理。不能擅自转为写文件、笔记或日历；明确要求创建文件或日程才调用。start新建；continue/cancel须指定task_id，不知道ID先list_tasks，详情用get_task。成功仅表示已接收，不能声称完成；最终结果另行通知。已接收的同一目标不得重复提交。闲聊不取消任务。',
    params: [
      { name: 'action', type: 'string', required: true, desc: '只能为 start、continue、cancel。查询任务请用 list_tasks 或 get_task。' },
      { name: 'task_id', type: 'string', required: false, desc: 'continue 和 cancel 必填：由端侧返回的任务 ID。start 不填，由端侧生成。不得使用 dsh session_id，不得猜测 ID。' },
      { name: 'goal', type: 'string', required: false, desc: 'start 和 continue 必填：用户明确提出的目标或追加要求，保留路径、文件名和限制。cancel 可为空。' },
      { name: 'context', type: 'string', required: false, desc: '必要的上下文及用户约束，不需要完整聊天历史。' }
    ],
    fewShotList: [
      { query: '帮我在当前工作目录创建一个测试文件', parameters: { action: 'start', goal: '在当前工作目录创建一个测试文件', context: '' } },
      { query: '请在当前工作目录创建 interview.txt，写入：下周二有快手agent面试。', parameters: { action: 'start', goal: '在当前工作目录创建 interview.txt，写入：下周二有快手agent面试。', context: '用户明确要求写入文件。' } },
      { query: '给任务 ID abc123 追加要求：按年份分组', parameters: { action: 'continue', task_id: 'abc123', goal: '按年份分组', context: '' } },
      { query: '取消任务 ID abc123', parameters: { action: 'cancel', task_id: 'abc123' } }
    ], execConfig
  },
  {
    name: 'list_tasks',
    description: '查询本次通话的所有电脑任务，包含进行中和已结束的任务，返回 task_id、名称、状态。用户询问有哪些任务、指代以前的任务但上下文中没有可靠 ID 时调用。需要详情再调用 get_task；需要继续或取消再用返回的 ID 调用 computer_task。',
    params: [],
    fewShotList: [
      { query: '现在有哪些电脑任务？', parameters: {} },
      { query: '刚才整理文件的是哪个任务？我想继续它', parameters: {} }
    ], execConfig
  },
  {
    name: 'get_task',
    description: '按 task_id 查询本次通话某个电脑任务的原始目标、追加要求、当前状态和各次执行结果。任务信息可能已离开聊天历史，查询此工具即可找回；不知道 ID 时先调用 list_tasks。只查询，不启动执行。',
    params: [{ name: 'task_id', type: 'string', required: true, desc: 'list_tasks 或 computer_task 返回的任务 ID，不得猜测。' }],
    fewShotList: [{ query: '查看任务 ID abc123 的进度和结果', parameters: { task_id: 'abc123' } }], execConfig
  }
];
export const taskToolSchema = {
  tool_set_name: 'olivia_soul',
  tools: taskTools.map(tool => ({
    tool_definition: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: Object.fromEntries(tool.params.map(p => [p.name, { type: p.type, description: p.desc }])), required: tool.params.filter(p => p.required).map(p => p.name) } },
    response_type: 'ON_EXECUTION_RESULT',
    usage_examples: tool.fewShotList.map(x => ({ text: x.query, tool_call: { arguments: x.parameters } }))
  }))
};
