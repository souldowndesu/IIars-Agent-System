import os
from fastapi.staticfiles import StaticFiles
import asyncio,uvicorn,fastapi,time,traceback
from fastapi import FastAPI,Request
from fastapi.responses import FileResponse,StreamingResponse
from fastapi.middleware.cors import CORSMiddleware #允许多端口
from contextlib import asynccontextmanager

import json,aiosqlite
from chat_logic import AsyncLLM, MAIN_DB_PATH, COMPACT_DB_PATH
import dotenv
import logging
from pydantic import BaseModel
from time_manager import TimeManager
api_time_manager = TimeManager(life_manager=None,db_path="database/time_table.db")


dotenv.load_dotenv()

# 配置日志
logging.basicConfig(
    level=logging.WARN,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

async def init_db():
    async with aiosqlite.connect(MAIN_DB_PATH) as db:
        await db.execute('''
            CREATE TABLE IF NOT EXISTS main_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                session_type TEXT NOT NULL,
                message_data TEXT NOT NULL,
                created_at REAL NOT NULL,
                created_at_str TEXT NOT NULL,
                is_compressed INTEGER DEFAULT 0
            )
        ''')
        await db.execute('CREATE INDEX IF NOT EXISTS idx_main ON main_messages(session_id, session_type, is_compressed)')
        await db.commit()

    async with aiosqlite.connect(COMPACT_DB_PATH) as db:
        await db.execute('''
            CREATE TABLE IF NOT EXISTS compact_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                session_type TEXT NOT NULL,
                message_data TEXT NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                created_at_str TEXT NOT NULL
            )
        ''')
        await db.execute('CREATE INDEX IF NOT EXISTS idx_compact ON compact_messages(session_id, session_type)')
        await db.commit()


class SessionManager:
    def __init__(self,timeout:int=1800):
        self.active_sessions = {}
        self.timeout = timeout
    async def get_asyncllm(self,session_id:str,session_type:str)->AsyncLLM:
        key = f"{session_id}:{session_type}"    #复合键,保存两种数据
        if key not in self.active_sessions:
            async_llm = AsyncLLM()
            await async_llm.load_history(session_id,session_type) #首次建立连接时读取本地 json
            self.active_sessions[key] = {
                "llm":async_llm,
                "session_type":session_type,
                "last_active":time.time(),      #用于记录没有发生对话的时间，以便清理内存，之后也可用于llm对于时间的处理(可优化点)
                "is_busy":False
            }
        else:
            self.active_sessions[key]["last_active"] = time.time()
        return self.active_sessions[key]["llm"]
    
    def update_activity(self,session_id:str,session_type:str="main"):
        key = f"{session_id}:{session_type}"
        if key in self.active_sessions:
            self.active_sessions[key]["last_active"] = time.time()
            
    async def flush_save_session(self,session_id:str,session_type:str="main"): #负责将对话内容进行保存
        key = f"{session_id}:{session_type}"
        if key in self.active_sessions:
            data = self.active_sessions[key]
            await data["llm"].save_history(session_id,session_type)
            logger.info(f"已强制 Flush 会话 {key} 的数据至数据库。")
    
    async def save_session(self,session_id:str,session_type:str="main"):
        key = f"{session_id}:{session_type}"
        if key in self.active_sessions:
            data = self.active_sessions.pop(key)
            # 断开连接时，将该会话内存全量写入json并使用pop清理内存
            await data["llm"].save_history(session_id,session_type)
            logger.info(f"会话 {key} ({data['session_type']}) 的新对话内容已增量存入 SQLite。")
    async def save_all(self):
        for key in list(self.active_sessions.keys()):
            sid, stype = key.split(":", 1)
            await self.save_session(sid, stype)

class StreamBroadcaster:
    def  __init__(self):
        self.clients:dict[str:list[asyncio.Queue]] = {}
        
    async def subscribe(self,session_id:str,session_type:str)->asyncio.Queue:
        key = f"{session_id}:{session_type}"
        if key not in self.clients:
            self.clients[key] = []
        queue = asyncio.Queue()
        self.clients[key].append(queue)
        return queue    #这个queue对象内存指向添加进去的queue对象
    
    async def unsubscribe(self,session_id:str,queue:asyncio.Queue,session_type:str):
        key = f"{session_id}:{session_type}"
        if key in self.clients and queue in self.clients[key]:
            self.clients[key].remove(queue)
            if not self.clients[key]:
                del self.clients[key]
    
    async def broadcast(self,session_id,message:dict,session_type:str):
        key = f"{session_id}:{session_type}"
        if key in self.clients:
            for queue in self.clients[key]:
                await queue.put(message)    #在建立联系后,所有输出内容只要进行broadcast都会同步

class ChatApp: #转发端口
    def __init__(self):
        self.app = FastAPI(lifespan=self.lifespan)  #可以使yield划分服务进行时与结束时的执行
        self.broadcaster = StreamBroadcaster()
        self.session_manager = SessionManager()
        
        self._setup_middleware()
        self._setup_routes()
        self.timeout_cleanup = True #暂时利用这个处理超过30min的任务，之后进行优化
        
    def _setup_middleware(self):
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],  # 允许所有域名跨域（开发时最方便）
            allow_credentials=True,
            allow_methods=["*"],  # 允许所有方法 (GET, POST 等)
            allow_headers=["*"],  # 允许所有请求头
        )
    
    def _setup_routes(self):
        @self.app.post("/cmd")
        async def execute_cmd(session_id:str,session_type:str="main",cmd:str=""):
            if cmd == "flush": #保存数据
                await self.session_manager.flush_save_session(session_id,session_type)
                return {"status":"flushed"}
                
            elif cmd == "refresh":  #重新加载数据
                key = f"{session_id}:{session_type}"
                if key in self.session_manager.active_sessions:
                    active_llm = self.session_manager.active_sessions[key]["llm"]
                    await active_llm.save_history(session_id, session_type)
                    await active_llm.load_history(session_id, session_type)
                return {"status":"refreshed"}
            
            elif cmd == "interrupt":
                key = f"{session_id}:{session_type}"
                if key in self.session_manager.active_sessions:
                    active_llm = self.session_manager.active_sessions[key]["llm"]
                    active_llm.interrupt()
                return {"status": "interrupt_sent"}
            elif cmd == "get_status":
                key = f"{session_id}:{session_type}"
                is_busy = False
                if key in self.session_manager.active_sessions:
                    is_busy = self.session_manager.active_sessions[key]["is_busy"]
                return {"status":"status_got","is_busy":is_busy}
            
            else:
                return {"status": "unknown_cmd"}
        
        class TaskCreate(BaseModel):#规范路由传入，是fastapi自动解析
            task_type:str
            is_recurring:bool
            recurrence_mode:str
            trigger_time:str
            action_cmd:str=""
            task_info:str=""
            session_id:str="main"
            session_type:str="main"
        
        @self.app.get("/tasks")
        def get_tasks():
            tasks = api_time_manager.get_all_tasks()
            return {"status":"ok","tasks":tasks}
        @self.app.post("/tasks")
        def create_task(task:TaskCreate):
            if task.task_type == "system":
                api_time_manager.set_system_task(
                    is_recurring=task.is_recurring,
                    mode=task.recurrence_mode,
                    trigger_expr=task.trigger_time,
                    action_cmd=task.action_cmd,
                    task_info=task.task_info
                )
            else:
                api_time_manager.set_agent_task(
                    is_recurring=task.is_recurring,
                    mode=task.recurrence_mode,
                    trigger_expr=task.trigger_time,
                    task_info=task.task_info,
                    session_id=task.session_id,
                    session_type=task.session_type
                )
            return {"status":"ok"}
        @self.app.delete("/tasks/{task_id}")
        def delete_task(task_id: int):
            api_time_manager.delete_task(task_id)
            return {"status":"ok"}
        
        @self.app.get("/get-history")
        async def get_history(session_id:str,session_type:str="main"):
            #优先从活跃内存会话读取完整消息，否则降级查询 SQLite
            messages = []
            try:
                key = f"{session_id}:{session_type}"
                active = self.session_manager.active_sessions.get(key)
                if active and hasattr(active.get("llm"),"messages"):
                    # 从内存 LLM 实例直接读取完整消息列表（含 tool_calls / name 等完整字段）
                    llm_messages = active["llm"].messages
                    for msg in llm_messages:
                        role = msg.get("role","")
                        if role == "system":
                            continue
                        content = msg.get("content") or ""
                        is_html = msg.get("isHtml") or msg.get("is_html") or False
                        messages.append({
                            "role":role,
                            "content":content,
                            "isHtml":is_html,
                            "tool_calls":msg.get("tool_calls"),
                            "name":msg.get("name"),
                            "tool_call_id":msg.get("tool_call_id"),
                            "reasoning_content":msg.get("reasoning_content"),
                            "time":""  #内存数据无时间戳
                        })
                    logger.info(f"get-history 从内存返回 {len(messages)} 条消息 (session={session_id})")
                    return {"status":"ok","session_id":session_id,"messages":messages}
                #从SQLite 读取
                async with aiosqlite.connect(MAIN_DB_PATH) as db:
                    await db.execute("PRAGMA journal_mode=WAL")
                    async with db.execute(
                        "SELECT message_data, created_at_str FROM main_messages WHERE session_id = ? AND session_type = ? ORDER BY id ASC",
                        (session_id,session_type)
                    ) as cursor:
                        rows = await cursor.fetchall()
                        for row in rows:
                            raw_data = row[0]
                            if not raw_data:
                                logger.warning(f"跳过空消息记录 (session={session_id})")
                                continue
                            try:
                                msg = json.loads(raw_data)
                            except (json.JSONDecodeError, TypeError) as e:
                                logger.warning(f"跳过损坏的消息记录: {str(raw_data)[:80]} - {e}")
                                continue
                            role = msg.get("role","")
                            is_html = msg.get("isHtml") or msg.get("is_html") or False
                            messages.append({
                                "role":role,
                                "content":msg.get("content") or "",
                                "isHtml":is_html,
                                "tool_calls":msg.get("tool_calls"),
                                "name":msg.get("name"),
                                "tool_call_id":msg.get("tool_call_id"),
                                "reasoning_content":msg.get("reasoning_content"),
                                "time":row[1] or ""
                            })
                logger.info(f"get-history 从 SQLite 返回 {len(messages)} 条消息 (session={session_id})")
                return {"status":"ok","session_id":session_id,"messages":messages}
            except Exception as e:
                logger.error(f"get-history 失败 (session={session_id}, type={session_type}): {e}")
                return {"status":"error","session_id":session_id,"messages":[],"error":str(e)}

        @self.app.post("/str-input") #需要将输入传输到该站点
        async def generate(session_id:str,session_type:str,user_input:str=None,message:str=None):
            parsed_message = None
            if message:
                try:
                    parsed_message = json.loads(message)
                except json.JSONDecodeError:
                    logger.error("解析 message 失败，必须是合法的 JSON 字符串")
                    return {"status":"error","msg":"Invalid JSON message"} 
            await self.session_manager.get_asyncllm(session_id,session_type)
            
            key = f"{session_id}:{session_type}"
            self.session_manager.active_sessions[key]["is_busy"] = True     #标记开始，llm执行结束会自动清除
            
            asyncio.create_task(self.llm_worker(user_input,parsed_message,session_id,session_type))
            return {"status":"started","session_id":session_id}

        @self.app.get("/stream")
        async def stream_endpoint(request:Request,session_id:str,session_type:str):
            logger.info(f"{session_id} 正在建立 SSE 连接...")
            queue = await self.broadcaster.subscribe(session_id,session_type)   #每次接受请求，都会运行这个函数，订阅并开启event_generator
            await self.session_manager.get_asyncllm(session_id,session_type) #在input执行前就尝试加载好llm端口，降低延迟
            
            async def event_generator():    #定义一个函数,用于输出迭代器
                try:
                    while True:
                        if await request.is_disconnected(): #只有主动断连,才会停止订阅
                            logger.info(f"{session_id} 检测到正常断开(is_disconnected)")
                            break
                        message = await queue.get()
                        yield f"data: {json.dumps(message,ensure_ascii=False)}\n\n"
                except asyncio.CancelledError:
                    logger.warning(f"{session_id} 连接被强制中断 (CancelledError)")
                    raise
                finally:
                    logger.info(f"{session_id} 进入 Finally，启动后台独立清理任务...")
                    async def safe_cleanup():   #设置独立的异步任务，防止因为cancelled导致保存过程被跳过
                        try:
                            await self.broadcaster.unsubscribe(session_id,queue,session_type)
                            await self.session_manager.save_session(session_id,session_type)
                            logger.info(f"{session_id} 清理与保存任务彻底完成。")
                        except Exception as e:
                            logger.error(f"{session_id} 清理时发生致命错误: {e}")
                    
                    asyncio.create_task(safe_cleanup())
                    
            return StreamingResponse(event_generator(),media_type="text/event-stream")  #会不断返回实例化的event_generator,即对应得迭代器      
        
        #静态挂载
        frontend_dir = "webui_react/dist"
        if os.path.exists(frontend_dir):
            @self.app.get("/")
            async def serve_index():
                return FileResponse(os.path.join(frontend_dir, "index.html"))
            self.app.mount("/", StaticFiles(directory=frontend_dir), name="static")
            #将整个前端文件夹挂载到根目录，用来加载 js 和 css 文件
        else:
            logger.warning(f"未找到前端文件夹 '{frontend_dir}'，将仅提供 API 服务。")
         
         
    @asynccontextmanager
    async def lifespan(self, app: FastAPI):#yield前会执行一次，断开服务后会执行之后的
        await init_db()
        logger.info("SQLite 数据库初始化完成。")
        
        stop_cleanup = asyncio.Event()
        async def cleanup_loop():
            while not stop_cleanup.is_set():
                await asyncio.sleep(60)
                if self.timeout_cleanup:
                    now = time.time()
                    expired = []
                    for sid,d in self.session_manager.active_sessions.items():
                        if now - d["last_active"] > self.session_manager.timeout:
                            expired.append(sid)
                    for sid in expired:
                        s, t = sid.split(":", 1)
                        await self.session_manager.save_session(s, t)
        
        cleanup_task = asyncio.create_task(cleanup_loop())
        yield  # 服务运行中
        # 接收到关闭信号，执行全量保存(可以看作asynccontextmanager环境的特殊写法)
        stop_cleanup.set()
        cleanup_task.cancel()
        await self.session_manager.save_all()

    async def llm_worker(self,user_input:str,message:dict,session_id:str,session_type:str):
        try:
            llm = await self.session_manager.get_asyncllm(session_id,session_type)   #获取对应的llm，更新一下时间记录
            await self.broadcaster.broadcast(session_id,{
                "event":"start",
                "session_id":session_id,
                "prompt":user_input
                },session_type)
            self.session_manager.update_activity(session_id,session_type) 
            async for res in llm.chat_stream(user_input=user_input,message=message):
                event_type = res.get("type")    #获取具体执行结果类型
                
                if event_type == "content":
                    await self.broadcaster.broadcast(session_id, {
                        "event":"content",
                        "data":res["data"]
                    },session_type)
                elif event_type == "tool_start":
                    await self.broadcaster.broadcast(session_id, {
                        "event":"tool_status",
                        "status":"start",
                        "name":res["name"]
                    },session_type)
                elif event_type == "tool_result":
                    await self.broadcaster.broadcast(session_id, {
                        "event":"tool_status",
                        "status":"result",
                        "name":res["name"],
                        "executed_well":res["result_status"],
                        "result_data": res.get("result_data", ""),
                        "tool_args": res.get("tool_args", "")
                    },session_type)
                elif event_type == "interrupt":
                    await self.broadcaster.broadcast(session_id, {
                        "event": "interrupt"
                    },session_type)
                    break
            await self.broadcaster.broadcast(session_id,{
                "event":"end",
            },session_type)
            await llm.save_history(session_id, session_type)    #每一次对话后都同步对话
        except Exception as e:
            logger.exception(f"llm_worker 发生异常: {e}")
            await self.broadcaster.broadcast(session_id,{
                "event": "error",
                "error_msg": str(e)
            },session_type)
        finally:
            key = f"{session_id}:{session_type}"
            if key in self.session_manager.active_sessions:
                self.session_manager.active_sessions[key]["is_busy"] = False


chat_app = ChatApp()
if __name__ == "__main__":
    uvicorn.run("chat_server:chat_app.app",host="127.0.0.1",port=8001,reload=True,reload_excludes=["*.db", "*.db-journal", "*.json"])