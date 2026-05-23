from life_manager import LifeManager
import sqlite3
import logging
from datetime import datetime,timedelta
import time
import requests
import json
import calendar

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("TimeManager")

class TimeManager:
    def __init__(self,life_manager:LifeManager,db_path:str):
        self.life = life_manager
        self.db_path = db_path
        self.chat_api_url = "http://127.0.0.1:8001"
        self._init_db()
        
    def _init_db(self):
        with sqlite3.connect(self.db_path) as db:
            db.execute('''
                CREATE TABLE IF NOT EXISTS time_table (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    task_type TEXT NOT NULL,           -- 'system' 或 'agent'
                    is_recurring INTEGER DEFAULT 0,    -- 0: 不循环, 1: 循环
                    recurrence_mode TEXT,              -- 循环模式：'none', 'daily', 'weekly', 'monthly'
                    trigger_time TEXT NOT NULL,        -- 触发时间，如 '08:30' 或 '1 08:00'，对于monthly任务，负数表示倒数天数，eg.-1为最后一天
                    next_run_time TEXT NOT NULL,       -- 系统计算出的下次绝对执行时间: "YYYY-MM-DD HH:MM"，
                    action_cmd TEXT,                   -- system用，如 'start','end','agent'
                    task_info TEXT,                    -- agent用，对话提示词
                    session_id TEXT,                   -- agent用，会话ID
                    session_type TEXT DEFAULT 'main',
                    triggered INTEGER DEFAULT 0        -- 确定是否执行，防止漏掉任务
                )
            ''')
            db.execute("CREATE INDEX IF NOT EXISTS idx_next_run ON time_table(next_run_time, triggered);")
            db.commit()    
    
    def _calculate_next_run(self,mode:str,trigger_expr:str,base_time:datetime=None)->str:
        if base_time is None:
            base_time = datetime.now()
        try:
            if mode == "none":
                #已经是绝对时间
                return trigger_expr
                
            elif mode == "daily":
                hour, minute = map(int, trigger_expr.split(":"))
                target = base_time.replace(hour=hour, minute=minute, second=0, microsecond=0)
                if target <= base_time: #如果今天的时间已过，算作明天
                    target += timedelta(days=1)
                return target.strftime("%Y-%m-%d %H:%M")
                
            elif mode == "weekly":
                w_str,time_str = trigger_expr.split(" ")
                target_w = int(w_str)
                hour,minute = map(int,time_str.split(":"))
                target = base_time.replace(hour=hour,minute=minute,second=0,microsecond=0)
                
                #计算需要向后加多少天
                days_ahead = target_w - target.isoweekday()
                if days_ahead < 0 or (days_ahead == 0 and target <= base_time):
                    days_ahead += 7
                target += timedelta(days=days_ahead)
                return target.strftime("%Y-%m-%d %H:%M")
                
            elif mode == "monthly":
                d_str,time_str = trigger_expr.split(" ")
                target_d = int(d_str)
                hour,minute = map(int,time_str.split(":"))
                
                test_year = base_time.year
                test_month = base_time.month
                for _ in range(24):
                    last_day_of_month = calendar.monthrange(test_year, test_month)[1]
                    #正数直接取，负数倒数计算 (-1表示最后一天)
                    if target_d > 0:
                        actual_d = target_d
                    else:
                        actual_d = last_day_of_month + target_d + 1
                    #检查计算出的日期在这个月是否合法
                    if 1 <= actual_d <= last_day_of_month:
                        target = datetime(test_year, test_month, actual_d, hour, minute)
                        #必须是未来时间
                        if target > base_time:
                            return target.strftime("%Y-%m-%d %H:%M")   
                    # 这个月不合法或时间已过，进入下个月
                    test_month += 1
                    if test_month > 12:
                        test_month = 1
                        test_year += 1
                        
                raise ValueError("在未来2年中找不到符合条件的月份")
                
        except Exception as e:
            logger.error(f"时间解析错误: {e}")
            return "2099-12-31 23:59" # 返回一个遥远的时间以防死循环
    
    def start_loop(self):
        logger.info("🕒 TimeManager 时间轮询已启动...")
        logger.info("🌅 执行启动系统指令...")
        self.life.start_all()
        time.sleep(30)
        try:
            while True:
                curr_time_str = datetime.now().strftime("%Y-%m-%d %H:%M")
                logger.info(f"正在查询，时间为 {curr_time_str}")
                
                with sqlite3.connect(self.db_path) as db:
                    cursor = db.execute(
                        "SELECT id, task_type, action_cmd, task_info, session_id, session_type, is_recurring, recurrence_mode, trigger_time "
                        "FROM time_table WHERE next_run_time <= ? AND triggered = 0",
                        (curr_time_str,)
                    )
                    tasks = cursor.fetchall()
                for task in tasks:
                    task_id,task_type,action_cmd,task_info,session_id,session_type,is_recurring,recurrence_mode,trigger_time = task
                    logger.info(f"⚡ 触发任务 ID:{task_id} 类型:{task_type} 时间:{curr_time_str}")

                    if task_type == "system":
                        self.task_trigger(task_info,session_id,session_type=session_type)
                        self.execute_action(action_cmd)
                    elif task_type == "agent":
                        self.task_trigger(task_info,session_id,session_type=session_type)
                        
                    with sqlite3.connect(self.db_path) as db_update:
                        if is_recurring == 1:#循环任务，更新时间
                            next_time = self._calculate_next_run(recurrence_mode, trigger_time)
                            db_update.execute("UPDATE time_table SET next_run_time = ? WHERE id = ?", (next_time, task_id))
                            logger.info(f"🔄 循环任务已重置，下次执行时间: {next_time}")
                        else:
                            #单次任务，直接标记为已触发
                            db_update.execute("UPDATE time_table SET triggered = 1 WHERE id = ?", (task_id,))
                        db_update.commit()
                        
                    if session_id:
                        self.wait_spare(session_id, session_type)
                        
                curr_sec = datetime.now().second
                time.sleep(max(0,65-curr_sec))
                
        except KeyboardInterrupt:
            logger.info("⏹️ 接收到退出信号，关闭 TimeManager 并清理底层服务...")
            self.execute_action("end")
        except Exception as e:
            logger.error(f"出现意外服务中断，error：{e}")
            self.execute_action("end")
            self.alert(e)    
    
    def wait_spare(self,session_id:str,session_type:str="main",max_wait:int=120):
        status_url = f"{self.chat_api_url}/cmd"
        params = {"session_id":session_id,"session_type":session_type,"cmd":"get_status"}
        start_wait = time.time()
        time.sleep(5)
        
        logger.info(f"⏳ 正在检查并等待会话 {session_id} 变为空闲...")
        while True:
            if time.time() - start_wait > max_wait:
                logger.warning(f"⚠️ 等待会话 {session_id} 空闲超时 ({max_wait}s)，强制跳过等待。")
                break
            try:
                res = requests.post(status_url,params=params,timeout=5).json()
                if not res.get("is_busy"):
                    time.sleep(0.5) #确认空闲后等待1秒
                    #再次校验
                    res_check = requests.post(status_url, params=params, timeout=5).json()
                    if not res_check.get("is_busy"):
                        logger.info(f"✅ 会话 {session_id} 确认空闲。")
                        break
                else:
                    time.sleep(0.5) # 忙碌中，持续轮询
            except Exception as e:
                logger.error(f"❌ 检查状态失败: {e}")
                time.sleep(1)
        
    def execute_action(self,cmd):
        if cmd == "start":
            logger.info("🌅 执行启动系统指令...")
            self.life.start_all()
        elif cmd == "end":
            time.sleep(60) #等待可能的对话的结束
            logger.info("🌙 执行关闭系统指令...")
            self.life.stop_all()
        elif cmd == "agent":
            pass
        else:
            logger.warning(f"⚠️ 未知的系统指令: {cmd}")

    def task_trigger(self,task_info:str,session_id:str,session_type:str="main"):
        if not session_id:
            logger.error("❌ 缺少 session_id，无法发送 agent 任务")
            return
        try:
            status_url = f"{self.chat_api_url}/cmd"

            status_params = {"session_id":session_id,"session_type":session_type,"cmd":"get_status"}
            res_status = requests.post(status_url, params=status_params, timeout=5).json()
            
            if res_status.get("is_busy"):
                interrupt_url = f"{self.chat_api_url}/cmd"
                params = {"session_id":session_id,"session_type":session_type,"cmd":"interrupt"}
                requests.post(interrupt_url,params=params,timeout=5)
                logger.info(f"🛑 已向会话 {session_id} 发送打断(interrupt)指令")
                time.sleep(0.8)
            else:
                logger.info(f"🟢 会话 {session_id} 当前空闲，直接推送任务。")
            
            input_url = f"{self.chat_api_url}/str-input"
            message = json.dumps({"role":"system","content":task_info})
            message_params = {
                "session_id":session_id, 
                "session_type":session_type,
                "message":message
            }
            res = requests.post(input_url,params=message_params,timeout=5)
            
            if res.status_code == 200:
                logger.info(f"✉️ 成功向会话 {session_id} 推送定时任务: {task_info[:20]}...")
            else:
                logger.error(f"❌ 推送任务失败，状态码: {res.status_code}")
            
        except requests.ConnectionError:
            logger.error(f"❌ 无法连接到 Chat Server ({self.chat_api_url})。服务可能未启动？")
        except Exception as e:
            logger.error(f"❌ _task_trigger 发生异常: {e}")
    
    def alert(self,e):
        pass
    
    def set_system_task(self,is_recurring:bool,mode:str,trigger_expr:str,action_cmd:str,task_info:str):
        is_rec_int = 1 if is_recurring else 0
        next_run = self._calculate_next_run(mode,trigger_expr)
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "INSERT INTO time_table (task_type, is_recurring, recurrence_mode, trigger_time, next_run_time, action_cmd, task_info, session_id, session_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("system",is_rec_int,mode,trigger_expr,next_run,action_cmd,task_info,"main","main")
            )
            db.commit()
        logger.info(f"✅添加 System 任务:模式[{mode}]规则[{trigger_expr}]->计划执行时间:{next_run}")
    
    def set_agent_task(self,is_recurring:bool,mode:str,trigger_expr:str,task_info:str,session_id:str,session_type:str="main"):
        is_rec_int = 1 if is_recurring else 0
        next_run = self._calculate_next_run(mode,trigger_expr)
        with sqlite3.connect(self.db_path) as db:
            db.execute(
                "INSERT INTO time_table (task_type, is_recurring, recurrence_mode, trigger_time, next_run_time, action_cmd, task_info, session_id, session_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("agent",is_rec_int,mode,trigger_expr,next_run,"agent",task_info,session_id,session_type)
            )
            db.commit()
        logger.info(f"✅添加 Agent 任务:模式[{mode}]规则[{trigger_expr}]->计划执行时间:{next_run}")

    def check_task(self):
        print("\n"+"="*40 +"\n📜 当前时间任务表 \n"+"="*40)
        with sqlite3.connect(self.db_path) as db:
            cursor = db.execute("SELECT id, task_type, trigger_time, action_cmd, task_info, session_id FROM time_table ORDER BY trigger_time ASC")
            tasks = cursor.fetchall()
            if not tasks:
                print("暂无任何任务。")
            for t in tasks:
                if t[1] == "system":
                    print(f"[{t[0]}] ⏰ {t[2]} | 💻 系统操作: {t[3]}")
                else:
                    print(f"[{t[0]}] ⏰ {t[2]} | 🤖 Agent通知 ({t[5]}): {t[4][:15]}...")
        print("="*40+"\n")

    def delete_task(self,task_id:int):
        with sqlite3.connect(self.db_path) as db:
            db.execute("DELETE FROM time_table WHERE id = ?",(task_id,))
            db.commit()
        logger.info(f"🗑️ 已删除任务 ID: {task_id}")
        
if __name__ == "__main__":
    life_manager = LifeManager()
    time_manager = TimeManager(life_manager=life_manager,db_path="database/time_table.db")
    time_manager.start_loop()    