import subprocess
import sys,os,time,signal,atexit,logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("LifeManager")

VENV_DIR = r"D:\Data\VS_code\AI-workplace\my-agent\.venv"
WSL_CONDA_ENV = "base"
WSL_CONDA_EXE = "/home/souldown/miniconda3/bin/conda"

class LifeManager:
    def __init__(self):
        self.servers = {}
        atexit.register(self.stop_all)  #当程序exit时执行
        #接受终止信号时，不直接退出，而是先执行以下指令
        signal.signal(signal.SIGINT,self._signal_handler)#interrupt   
        signal.signal(signal.SIGTERM,self._signal_handler)#terminate
        
    def _signal_handler(self,signum,frame):#api格式要求
        logger.info("接收到终止信号，正在关闭运行服务...")
        sys.exit(0)
        
    def _windows_to_wsl_path(self,win_path:str=None)->str:
        win_path = os.path.abspath(win_path).replace('\\', '/')
        if ':' in win_path:
            drive,tail = win_path.split(':',1)
            return f"/mnt/{drive.lower()}{tail}"
        return win_path
    
    def _is_server_running(self,name:str)->bool:
        if name in self.servers:
            p = self.servers[name]["server"]
            if p.poll() is None:  # poll()为None说明进程正在运行
                return True
            else:
                #进程已经退出，从管理字典中移除旧数据
                self.servers.pop(name)
        return False
    
    def run_server(self,script_path:str,venv_dir:str=None,conda_env:str=None,conda_exe:str=None):
        server_name = os.path.basename(script_path)
        if self._is_server_running(server_name):
            logger.info(f"ℹ️ 本地服务 [{server_name}] 已经在运行中，跳过重复启动。")
            return
        
        if conda_env:
            cmd = [conda_exe or "conda","run","-n",conda_env,"python",script_path]
            env_type = f"Conda:{conda_env}"
        elif venv_dir:
            python_exe = os.path.join(venv_dir,"Scripts","python.exe")
            if not os.path.exists(python_exe):
                logger.error(f"❌ 找不到虚拟环境的 Python: {python_exe}")
                return
            cmd = [python_exe,script_path]
            env_type = "Venv"
        else:
            cmd = [sys.executable,script_path]
            env_type = "Default"
        
        server = subprocess.Popen(cmd)
        self.servers[server_name]={"server":server,"type":"Local"}
        logger.info(f"🚀 [Win {env_type}] 启动: {' '.join(cmd)}")
        
    def run_wsl_server(self,win_script_path:str=None,wsl_script_path:str=None,venv_dir:str=None,conda_env:str=None,wsl_conda_exe:str=None):
        server_name = os.path.basename(win_script_path or wsl_script_path)
        if self._is_server_running(server_name):
            logger.info(f"ℹ️ WSL 服务 [{server_name}] 已经在运行中，跳过重复启动。")
            return
        
        if win_script_path:
            wsl_script_path = self._windows_to_wsl_path(win_script_path)
        if conda_env:
            linux_cmd = f"{wsl_conda_exe or "conda"} run -n {conda_env} python {wsl_script_path}"
            env_type = f"Conda: {conda_env}"
        elif venv_dir:
            wsl_venv_path = self._windows_to_wsl_path(venv_dir)
            linux_cmd = f"{wsl_venv_path}/bin/python {wsl_script_path}"
            env_type = "Venv"
        else:
            linux_cmd = f"python3 {wsl_script_path}"
            env_type = "Default"
            
        cmd = ["wsl","--exec","bash","-c",linux_cmd]
        server = subprocess.Popen(cmd)
        self.servers[server_name]={"server":server,"type":"WSL"}
        logger.info(f"🐧 [WSL {env_type}] 启动: {linux_cmd}")
        
    def stop(self,server_name:str):
        if server_name in self.servers:
            p_info = self.servers[server_name]
            p = p_info["server"]
            if p.poll() is None:
                logger.info(f"🛑 停止服务 [{p_info['type']}] {server_name}...")
                p.terminate()
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    p.kill()
            self.servers.pop(server_name)
        
    def stop_all(self):
        for name,p_info in self.servers.items():
            p = p_info["server"]
            if p.poll() is None:
                logger.info(f"🛑 停止服务 [{p_info['type']}] {name}...")
                p.terminate()
                try:
                    p.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    p.kill()
        self.servers.clear()
        
    def keep_alive(self):
        logger.info("🟢 驻留模式开启，按 Ctrl+C 关闭所有服务。")
        try:
            while True:
                time.sleep(1)
                
        except KeyboardInterrupt:
            pass

    def start_all(self):
        self.run_server(script_path=r"D:\Data\VS_code\AI-workplace\my-agent\src\chat_server.py",venv_dir=VENV_DIR)
        self.run_wsl_server(win_script_path=r"D:\Data\VS_code\AI-workplace\my-agent\wsl_code\cmd_server.py",conda_env=WSL_CONDA_ENV,wsl_conda_exe=WSL_CONDA_EXE)
        self.keep_alive()

if __name__ == "__main__":
    life_manager = LifeManager()
    life_manager.run_server(script_path=r"D:\Data\VS_code\AI-workplace\my-agent\src\chat_server.py",venv_dir=VENV_DIR)
    life_manager.run_wsl_server(win_script_path=r"D:\Data\VS_code\AI-workplace\my-agent\wsl_code\cmd_server.py",conda_env=WSL_CONDA_ENV,wsl_conda_exe=WSL_CONDA_EXE)
    life_manager.keep_alive()
    