from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import pexpect # pyright: ignore
import asyncio
import re
import uvicorn
import os
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] WSL_Server - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger(__name__)

app = FastAPI()

class CommandRequest(BaseModel):
    command: str
    timeout: int = 30

class BashSession:
    def __init__(self):
        self.child = None
        self.lock = asyncio.Lock()  #防止一次性注入多条指令
        self._start_session()
           
    def _start_session(self):
        if self.child is not None and self.child.isalive():
            self.child.terminate(force=True)
        logger.info("[WSL Boot] 正在启动后台纯净 Bash 伪终端...")
        
        env = os.environ.copy()
        env['TERM'] = 'dumb'
        #使用--norc--noprofile避开.bashrc的干扰,设置TERM=dumb禁用ANSI颜色和控制字符
        self.child = pexpect.spawn(
            '/bin/bash', 
            args=['--norc','--noprofile'], 
            env=env,
            encoding='utf-8', 
            timeout=30, 
            dimensions=(24,160)
        )
        
        self.child.sendline("stty -echo; export PS1=''; echo '===INIT_DONE==='")    #PS1标记的是输出完后用什么代替(base) username@admin:,这里设置为空
        self.child.expect('===INIT_DONE===')
        #执行指令关闭回显，同时确认完成初始化
        
        self._flush_buffer()    #清空缓存
        logger.info("[WSL Boot] Bash 纯净环境初始化完毕，等待指令接入。")
    
    def _flush_buffer(self):    
        try:
            while True:
                self.child.read_nonblocking(size=4096, timeout=0.1)
        except (pexpect.TIMEOUT, pexpect.EOF):
            pass
    
    async def execute(self,command:str,timeout:int)->dict:
        async with self.lock:
            self._flush_buffer()
            
            end_marker = "===AGENT_CMD_END==="  #以此作为结束符，减少重名风险(防止其他形式意外输出该字符)
            full_command = f'{command}\necho "\n{end_marker}:$?"' 
            logger.debug(f"[WSL Execute] 接收到指令: {command}")
            
            self.child.sendline(full_command)   #发送指令

            def _wait_for_output():
                self.child.expect(f"{end_marker}:(\\d+)",timeout=timeout)   #以结束符出现为标志
                exit_code = int(self.child.match.group(1))   #获取匹配的退出码
                out = self.child.before #获得输出内容
                return exit_code,out
                
            try:
                exit_code,raw_output = await asyncio.to_thread(_wait_for_output)  #独立线程防止阻塞
                logger.debug(f"[WSL Execute] ---> 原始输出流(Raw): {repr(raw_output)}")
                
            except pexpect.TIMEOUT:
                logger.error(f"[WSL Execute] ❌ 严重错误: 指令执行超时卡死！正在发送 Ctrl+C 中断...")
                self.child.sendintr()   #中断进程
                try:
                    self.child.expect(f"{end_marker}:",timeout=3)   #等待中断，若依然不成功说明卡死
                except:
                    self._start_session()   #这时重启bash
                return {"status":"error", "exit_code":-1, "output": f"Timeout after {timeout}s"}
            except Exception as e:
                 return {"status":"error", "exit_code":-1, "output": str(e)}

            #清洗数据格式
            lines = raw_output.strip().split('\r\n')
            clean_output = '\n'.join(lines).strip()
            
            #截断保护：防止输出超过 8000 字撑爆大模型 Token
            if len(clean_output) > 8000:
                clean_output = clean_output[:8000] + "\n...[Output Truncated]..."
            return {
                "status": "success" if exit_code == 0 else "failed",
                "exit_code": exit_code,
                "output": clean_output or "No output."
            }
        
session = BashSession()

@app.post("/execute")
async def execute_command(req:CommandRequest):
    try:
        result = await session.execute(req.command,req.timeout) #从post中获取command与timeout
        return result   #返回result json文件
    except Exception as e:
        print(f"[WSL Server Error] API 接口发生崩溃: {str(e)}",flush=True)
        raise HTTPException(status_code=500, detail=str(e)) #处理网络问题
    
if __name__ == "__main__":
    uvicorn.run(app,host="0.0.0.0",port=8000)