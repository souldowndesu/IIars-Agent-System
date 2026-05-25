from openai import AsyncOpenAI
import dotenv,os,aiofiles,json
import logging
import aiosqlite
import time
from typing import List,Union
from load_and_registry import ToolRegistry,PromptLoader,tools_dir,BASE_TOOLS

dotenv.load_dotenv()

logger = logging.getLogger(__name__)

MAIN_DB_PATH = "database/main_messages.db"
COMPACT_DB_PATH = "database/compact_chat.db"

class AsyncLLM:
    def __init__(self,api_key:str=None,model:str=None,base_url:str=None,registry:ToolRegistry=None,prompt_loader:PromptLoader=None):
        self.client = AsyncOpenAI(
            api_key=api_key or os.getenv("API_KEY"),
            base_url=base_url or os.getenv("BASE_URL")
            )
        self.model = model or os.getenv("MODEL")
        
        self.database_dir = "database"
        os.makedirs(self.database_dir,exist_ok=True)
        
        self.messages = [{"role":"system","content":"你是一个agent程序的llm核心，如果你接收到了这条提示，说明正确的提示词并未正式加载，你需要提醒用户这一点"}]
        self.timestamps = [time.time()]
        
        self.use_tool = 1
        if self.use_tool == 1: #注册的tools 
            self.registry = registry if registry else ToolRegistry(tools_path=tools_dir,registered_tools=BASE_TOOLS)
        else:
            self.registry = None  
        self._saved_index = 0   #已经保存的数量,防止重复保存,标记了messages中保存过的数量
        
        self.prompt_loader =  prompt_loader or PromptLoader()
        
        #压缩的起始终止时间，0为异常值，可判别是否成功
        self.compact_start_time = 0.0
        self.compact_end_time = 0.0
        
        self._interrupted = False
        
        #主要用于处理对msg的处理，获取的msg需要在返回tool调用结果后再放入，所以这里先暂存，然后才加载
        self._pending_messages = []
        self._pending_timestamps = []
    
    #工具管理
    def add_tool(self,tool_names:Union[str,List[str]]):
        if self.registry:
            self.registry.add_tool(tool_names)
            logger.info(f"为当前会话动态添加了工具: {tool_names}")
        else:
            logger.warning("当前 LLM 实例未启用工具 (use_tool != 1)，无法添加工具。")

    def delete_tool(self,tool_names:Union[str,List[str]]):
        if self.registry:
            self.registry.delete_tool(tool_names)
            logger.info(f"为当前会话动态移除了工具: {tool_names}")
            
    def check_tools(self)->List[str]:
        if self.registry:
            return self.registry.get_active_modules()
        return []
    
    async def load_prompt(self,prompt_type:str=None):
        prompt_text = await self.prompt_loader.get_base_prompt(prompt_type)
        
        if prompt_text is None:
            self.messages.append({"role":"system","content":"你是一个agent程序的llm核心，如果你接收到了这条提示，说明正确的提示词并未正式加载，你需要提醒用户这一点，然后将现在的历史记录总结一下"})
            self.timestamps.append(time.time())
            self._saved_index += 1
            logger.error(f"{prompt_type} 类型 提示词加载失败")
        else:
            self.messages.append({"role":"system","content":prompt_text})
            self.timestamps.append(time.time())
            self._saved_index += 1
            logger.info(f"已加载 {prompt_type} 类型 system prompt")
    
    async def load_skill(self,skill_path:str=None):
        skill_text = await self.prompt_loader.read_skill(skill_path)
        
        msg = {"role": "system", "content": ""}
        if skill_text is None:
            msg["content"] = f"{skill_path} 位置的skill加载失败"
            logger.error(f"{skill_path} 位置skill加载失败")
        else:
            msg["content"] = skill_text
            logger.info(f"已加载 {skill_path} 处的skill")
            
        if self.messages and self.messages[-1].get("role") == "assistant" and "tool_calls" in self.messages[-1]:
            self._pending_messages.append(msg)  #防止插入，导致openai的msg格式错误(tool后必须紧跟tool结果)
            self._pending_timestamps.append(time.time())
        else:
            self.messages.append(msg)
            self.timestamps.append(time.time())
            self._saved_index += 1
        
        
    def interrupt(self):

        self._interrupted = True
    
    async def chat_stream(self,user_input:str=None,message:dict=None):
        if user_input:
            self.messages.append({"role":"user","content":user_input})
            self.timestamps.append(time.time())
        elif message:
            self.messages.append(message)
            self.timestamps.append(time.time())
        
        while True:
            resp = await self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                stream=True,
                tools=self.registry.get_schema() if self.registry else None     #执行too挂载，表示可用的tools
            )
        
            full_reply = ""
            reasoning_reply = ""
            tool_calls_buffer = {}   #存放碎片化的tool calls
            
            async for chunk in resp:
                if not chunk.choices: 
                    continue    #去除空块
                delta = chunk.choices[0].delta
                
                if hasattr(delta,'reasoning_content') and delta.reasoning_content:
                    reasoning_reply += delta.reasoning_content
                
                if delta.content:
                    word = delta.content
                    full_reply += word
                    yield {"type":"content","data":word}
                
                if delta.tool_calls: #出现了工具调用的请求
                    for tc_delta in delta.tool_calls:
                        index = tc_delta.index  #对应调用tool的标签
                        if index not in tool_calls_buffer:     #确定是新调用的tool
                            tool_calls_buffer[index] = {
                                "id":tc_delta.id,
                                "name":tc_delta.function.name,
                                "args":""
                            }
                            logger.info(f"Model is calling tool: {tc_delta.function.name}")
                            yield {"type":"tool_start","name":tool_calls_buffer[index]["name"]}  #只在第一次出现该工具时输出
                        if tc_delta.function.arguments:
                            tool_calls_buffer[index]["args"] += tc_delta.function.arguments #逐渐拼接tool_call的内容

                #中断检测：外层每次chunk迭代后检查
                if self._interrupted:
                    # 将当前已累积的部分内容 + tool_calls 写入 messages
                    partial_msg = {"role":"assistant","content":full_reply or None}
                    if reasoning_reply:
                        partial_msg["reasoning_content"] = reasoning_reply
                    if tool_calls_buffer:
                        formatted_calls = []
                        for tc in tool_calls_buffer.values():
                            formatted_calls.append({
                                "id":tc["id"],
                                "type":"function",
                                "function":{"name":tc["name"],"arguments":tc["args"]}
                            })
                        partial_msg["tool_calls"] = formatted_calls
                    # 中断时若既无 content 也无 tool_calls，设占位内容防止再次加载时报 API 错误
                    if not partial_msg.get("content") and not partial_msg.get("tool_calls"):
                        partial_msg["content"] = "[思考中]"
                    self.messages.append(partial_msg)
                    self.timestamps.append(time.time())
                    #为中断时未执行的 tool_calls 补充占位 tool 回复，防止下次 API 调用报 400
                    if "tool_calls" in partial_msg:
                        for tc in partial_msg["tool_calls"]:
                            self.messages.append({
                                "role":"tool",
                                "tool_call_id":tc["id"],
                                "content":"[工具调用被中断]"
                            })
                            self.timestamps.append(time.time())
                    #追加打断记录
                    self.messages.append({
                        "role":"assistant",
                        "content":"[对话被打断]"
                    })
                    self.timestamps.append(time.time())
                    self._interrupted = False
                    yield {"type":"interrupt"}
                    return  #直接退出整个 chat_stream 生成器
                            
            assistant_msg = {"role":"assistant","content":full_reply or None}
            
            if reasoning_reply:
                assistant_msg["reasoning_content"] = reasoning_reply
            
            if tool_calls_buffer: #有调用工具
                formatted_calls = []
                for tc in tool_calls_buffer.values():
                    formatted_calls.append({
                        "id":tc["id"],
                        "type":"function",
                        "function":{"name":tc["name"],"arguments":tc["args"]}
                    })
                assistant_msg["tool_calls"] = formatted_calls
                self.messages.append(assistant_msg)
                self.timestamps.append(time.time())
                
                for tc in formatted_calls:
                    func_name = tc["function"]["name"]
                    args_str = tc["function"]["arguments"]
                    executed_well = True
                    result_str = ""
                    
                    if not self.registry:
                        result_str = "Error: ToolRegistry is missing, cannot execute tools."
                        executed_well = False
                    
                    try:
                        args = json.loads(args_str) if args_str else {} #这里有一个防御性措施，防止非法json，也许可以调用修复模型对其进行更改
                        result_data = await self.registry.execute(func_name,args,agent=self)#传入agent自身，使其能够处理自身与使用自身的函数
                        # 对dict/list结果使用格式化JSON，便于前端在终端面板中展示
                        if isinstance(result_data, (dict, list)):
                            result_str = json.dumps(result_data,ensure_ascii=False,indent=2)
                        else:
                            result_str = str(result_data)
                    except json.JSONDecodeError:
                        result_str = "Error: Invalid JSON arguments provided."
                        executed_well = False
                    except Exception as e:
                        result_str = f"Error executing {func_name} :{str(e)}"   #将结果返回模型
                        executed_well = False
                    
                    clean_log_str = result_str.replace("\n", "\\n").replace("\r", "")
                    logger.info(f"Tool [{func_name}] Result: {clean_log_str[:150]}{'...(truncated)' if len(clean_log_str) > 150 else ''}")

                    yield {"type":"tool_result","name":func_name,"result_status":executed_well,"result_data":result_str,"tool_args":args_str}   #一个比较完整的输出
                    
                    self.messages.append({
                        "role":"tool",
                        "tool_call_id":tc["id"],
                        "name":func_name,
                        "content":result_str
                    })
                    self.timestamps.append(time.time())
                continue #循环执行，直到完成完整链路
                
            else:   #没有工具调用
                self.messages.append(assistant_msg)
                self.timestamps.append(time.time())
                break   #此时不必继续循环
                
        
    async def load_history(self,session_id:str,session_type:str):
        #初始化：保留系统提示词
        self.messages = []
        self.timestamps = []
        await self.load_prompt(session_type)
        
        if session_type == "main":
            #从compact库加载最新压缩摘要（作为历史上下文）
            async with aiosqlite.connect(COMPACT_DB_PATH) as db_compact:
                try:
                    async with db_compact.execute(
                        "SELECT message_data, end_time FROM compact_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1",(session_id,)
                    ) as cursor:
                        row = await cursor.fetchone()
                        if row:
                            self.messages.append(json.loads(row[0]))
                            self.timestamps.append(row[1])  #用结束时间作为该摘要的时间戳
                except aiosqlite.OperationalError:
                    logger.warning("列表未创建或无法加载")    #表还没创建时忽略
            
            #加载未被压缩的内容，is_compress==0
            async with aiosqlite.connect(MAIN_DB_PATH) as db_main:
                try:
                    async with db_main.execute(
                        "SELECT message_data, created_at FROM main_messages WHERE session_id = ? AND session_type = ? AND is_compressed = 0 ORDER BY id ASC",(session_id,session_type)
                    ) as cursor:
                        rows = await cursor.fetchall()
                        for row in rows:
                            try:
                                self.messages.append(json.loads(row[0]))
                                self.timestamps.append(row[1])
                            except json.JSONDecodeError:
                                logger.error(f"Failed to decode message JSON for session {session_id}")
                except aiosqlite.OperationalError:
                    logger.warning("列表未创建或无法加载")    #表还没创建时忽略
            
            #如果数据库中没有system消息，已在初始化时保留，无需额外处理
            
            self._saved_index = len(self.messages)
            logger.info(f"加载 main 类型历史记录成功，共 {len(self.messages)} 条上下文明细。")
        
        elif session_type == "temp":
            # temp 会话直接加载自身历史（无压缩流程）
            async with aiosqlite.connect(MAIN_DB_PATH) as db_main:
                try:
                    async with db_main.execute(
                        "SELECT message_data, created_at FROM main_messages WHERE session_id = ? AND session_type = ? ORDER BY id ASC",(session_id, session_type)
                    ) as cursor:
                        rows = await cursor.fetchall()
                        for row in rows:
                            try:
                                self.messages.append(json.loads(row[0]))
                                self.timestamps.append(row[1])
                            except json.JSONDecodeError:
                                logger.error(f"Failed to decode message JSON for session {session_id}")
                except aiosqlite.OperationalError:
                    pass
            self._saved_index = len(self.messages)
            logger.info(f"加载 temp 类型历史记录成功，共 {len(self.messages)} 条上下文明细。")

        elif session_type == "compact":  
            #从compact库加载最新压缩摘要（作为历史上下文）
            async with aiosqlite.connect(COMPACT_DB_PATH) as db_compact:
                try:
                    async with db_compact.execute(
                        "SELECT message_data, end_time FROM compact_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1",(session_id,)
                    ) as cursor:
                        row = await cursor.fetchone()
                        if row:
                            self.messages.append(json.loads(row[0]))
                            self.timestamps.append(row[1])  #用结束时间作为该摘要的时间戳
                except aiosqlite.OperationalError:
                    logger.warning("列表未创建或无法加载")    #表还没创建时忽略    
                       
            async with aiosqlite.connect(MAIN_DB_PATH) as db_main:
                try:
                    async with db_main.execute(
                        "SELECT message_data, created_at FROM main_messages WHERE session_id = ? AND session_type = 'main' AND is_compressed = 0 ORDER BY id ASC",
                        (session_id,)
                    ) as cursor:
                        rows = await cursor.fetchall()
                        if rows:
                            #记录要压缩的数据的起始与终止时间锚点
                            self.compact_start_time = rows[0][1]
                            self.compact_end_time = rows[-1][1]
                            
                            for row in rows:
                                try:
                                    self.messages.append(json.loads(row[0]))
                                    self.timestamps.append(row[1])
                                except json.JSONDecodeError:
                                    logger.error(f"Failed to decode message JSON for session {session_id}")
                except aiosqlite.OperationalError:
                    logger.warning("列表未创建或无法加载")
            
            self._saved_index = len(self.messages)
            logger.info(f"加载 compact 类型历史记录成功，共 {len(self.messages)} 条待压缩消息。")
        else:
            self._saved_index = len(self.messages)

    async def save_history(self,session_id:str,session_type:str):
        new_msgs = self.messages[self._saved_index:]
        new_ts = self.timestamps[self._saved_index:]
        
        if not new_msgs:
            return  #没有新消息，不需要写入
        
        if session_type == "main" or session_type == "temp":
            async with aiosqlite.connect(MAIN_DB_PATH) as db:
                for msg, ts in zip(new_msgs, new_ts):
                    formatted_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
                    
                    await db.execute(
                        """INSERT INTO main_messages 
                        (session_id, session_type, message_data, created_at, created_at_str, is_compressed) 
                        VALUES (?, ?, ?, ?, ?, 0)""",
                        (session_id, session_type, json.dumps(msg, ensure_ascii=False), ts, formatted_time)
                    )
                await db.commit()
        
        elif session_type == "compact":
            #提取回复的总结文本（只取assistant的content）
            summary_content = ""
            for msg in new_msgs:
                if msg.get("role") == "assistant" and msg.get("content"):
                    summary_content += msg["content"]
            if summary_content:
                #包装为system角色,方便直接导入
                summary_msg = {"role":"system","content":f"前情提要/压缩记忆: {summary_content}"}
                created_at_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
                #存入sqlite
                async with aiosqlite.connect(COMPACT_DB_PATH) as db:
                    await db.execute(
                        "INSERT INTO compact_messages (session_id,session_type,message_data,start_time,end_time,created_at_str) VALUES (?, ?, ?, ?, ?, ?)",
                        (session_id,"compact",json.dumps(summary_msg, ensure_ascii=False),self.compact_start_time,self.compact_end_time,created_at_str)
                    )
                    await db.commit()
                #将main_messages中对应时间段的记录标记为已压缩
                async with aiosqlite.connect(MAIN_DB_PATH) as db:
                    await db.execute(
                        "UPDATE main_messages SET is_compressed = 1 WHERE session_id = ? AND session_type = 'main' AND created_at >= ? AND created_at <= ?",(session_id, self.compact_start_time, self.compact_end_time)
                    )
                    await db.commit()
                
                logger.info(f"会话 {session_id} 压缩完成，已标记 {self.compact_start_time}~{self.compact_end_time} 范围内的消息为已压缩。")
            else:
                logger.warning(f"会话 {session_id} 的 compact 保存未提取到有效的助手总结内容。")
        
        self._saved_index = len(self.messages)  #更新已保存对象
