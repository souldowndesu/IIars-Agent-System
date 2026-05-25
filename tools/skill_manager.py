import os

TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "skill_manager",
        "description": "系统级管理工具：用于管理工具挂载、扫描本地文件，以及加载Skill(提示词)。在加载新工具前，先使用load_skill加载skill/tool_tree",
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "description": "操作类型：'add'(加载工具), 'delete'(卸载工具), 'check'(查看当前已挂载), 'list_local'(扫描本地可用的工具文件), 'load_skill'(动态读取Skill文件)",
                    "enum": ["add", "delete", "check", "list_local", "load_skill"]
                },
                "targets": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "目标名称列表：对于add/delete是工具文件名，对于load_skill是skill文件路径。check和list_local操作时可传空数组[]。"
                }
            },
            "required": ["action", "targets"]
        }
    }
}

# 【关键点】：我们在参数列表中声明了 agent。
# 因为我们在 registry 做了拦截判断，LLM 生成的 JSON 里不需要(也无法)包含 agent，
# 它是被框架直接在后端静默塞进来的！
async def execute(action: str, targets: list, agent):
    if action == "list_local":
        if not agent.registry:
            return "当前 LLM 未启用 registry，无法扫描。"
        tools_dir = agent.registry.tools_path
        # 扫描去除 .py 后缀的文件名
        available_tools = [f[:-3] for f in os.listdir(tools_dir) if f.endswith(".py") and not f.startswith("__")]
        return f"本地磁盘中可用的工具文件列表 (请使用这些准确的名称进行 add 操作): {available_tools}"

    # 2. 调用 AsyncLLM 已有的 load_skill 方法
    elif action == "load_skill":
        if not targets:
            return "参数 targets 不能为空，请提供 skill 文件路径"
        for skill_path in targets:
            await agent.load_skill(skill_path) 
        return f"已尝试读取 skill 文件 {targets}，执行结果已注入当前对话上下文中。"

    # 3. 【新增】：智能加载全局 Skill 树
    elif action == "load_skill_tree":
        default_tree_path = "skills/skill_tree.md" # 默认全局路径
        
        # 为了不触发底层 load_skill 找不到文件时的"报错提示词"，我们在工具层先探一下路
        if os.path.isfile(default_tree_path):
            await agent.load_skill(default_tree_path)
            return f"已成功读取默认的全局 Skill 树: {default_tree_path}，内容已注入上下文。"
        else:    
            return f"未能找到默认 Skill 树 ({default_tree_path})，请尝试在{default_tree_path}中进行查找"
             
    if action == "check":
        current_tools = agent.check_tools()
        return f"当前系统已挂载的工具列表: {current_tools}"
        
    elif action == "add":
        if not targets:
            return "参数 tools 不能为空"
            
        # 1. 尝试让底层去加载
        agent.add_tool(targets)
        
        # 2. 核心修改：查一下当前已有的工具，看看咱们要加的工具到底进去了没？
        current_tools = agent.check_tools()
        success_list = [t for t in targets if t in current_tools]
        failed_list = [t for t in targets if t not in current_tools]
        
        if failed_list:
            return f"⚠️ 加载完毕，但有异常！\n成功加载: {success_list}\n加载失败: {failed_list}。(可能是文件不存在、代码内有报错或格式不符，需要人类检查终端日志)"
        else:
            return f"成功加载工具: {success_list}。"
        
    elif action == "delete":
        if not targets:
            return "参数 tools 不能为空"
            
        agent.delete_tool(targets)
        
        # 同理，检查一下到底删干净没
        current_tools = agent.check_tools()
        failed_list = [t for t in targets if t in current_tools]
        success_list = [t for t in targets if t not in current_tools]
        
        if failed_list:
            return f"⚠️ 卸载遇到异常！\n成功卸载: {success_list}\n未能卸载: {failed_list}"
        return f"成功卸载工具: {success_list}。"
        
    return f"未知的操作指令: {action}"