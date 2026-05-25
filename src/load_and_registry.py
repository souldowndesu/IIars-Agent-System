import logging
import os,asyncio,inspect,aiofiles
from typing import List,Dict,Any,Callable,Union
import importlib.util
logger = logging.getLogger(__name__)

class ToolRegistry:
    def __init__(self,tools_path:str,registered_tools:List[str]=None):
        self.tools_path = tools_path
        self._tool_schemas:List[Dict] = []
        self._tool_callables:Dict[str,Callable] = {}
        self._registered_modules = set() 
        #建立模块名(文件名)->工具名(function_name) 的映射
        self._module_to_tool_name:Dict[str,str] = {}
        if registered_tools:
            self.add_tool(registered_tools)
            
    def _load_and_register_single(self,module_name:str,file_path:str):#单个tool加载
        try:
            spec = importlib.util.spec_from_file_location(module_name, file_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module) 
            if hasattr(module,"TOOL_SCHEMA") and hasattr(module,"execute"):
                schema = getattr(module,"TOOL_SCHEMA")
                func = getattr(module,"execute")
                name = schema.get("function",{}).get("name")

                if not name:
                    logger.error(f"{module_name}.py 的 TOOL_SCHEMA 缺少 function.name 字段，跳过。")
                    return
                    
                #如果存在同名 function_name给出警告（可能会被覆盖）
                if name in self._tool_callables:
                    logger.warning(f"工具名冲突: 注册表中已存在工具 [{name}]，将被新模块覆盖。")

                #注册
                self._tool_schemas.append(schema)
                self._tool_callables[name] = func
                self._registered_modules.add(module_name)
                self._module_to_tool_name[module_name] = name  #保存映射
                logger.info(f"成功扫描并装配工具: {name} (来自 {module_name}.py)")
            else:
                logger.warning(f"{module_name}.py 缺失 TOOL_SCHEMA 或 execute，不符合协议，已跳过。")
        except Exception as e:  
            logger.exception(f"动态加载模块 {module_name} 时发生崩溃: {e}")
            
    def add_tool(self,tool_names:Union[str,List[str]]):
        if isinstance(tool_names,str):
            tool_names = [tool_names]
        for module_name in tool_names:
            if module_name in self._registered_modules:
                logger.debug(f"工具模块 [{module_name}] 已存在，跳过加载。")
                continue
            file_path = os.path.join(self.tools_path,f"{module_name}.py")
            if not os.path.isfile(file_path):
                logger.warning(f"未找到工具文件: {file_path}")
                continue
            
            self._load_and_register_single(module_name,file_path)
    
    def delete_tool(self,tool_names:Union[str,List[str]]):
        if isinstance(tool_names,str):
            tool_names = [tool_names]
            
        for module_name in tool_names:
            if module_name not in self._registered_modules:
                logger.warning(f"无法删除，工具模块 [{module_name}] 并未加载。")
                continue
            func_name = self._module_to_tool_name.get(module_name)
            if func_name:
                #移除 callable
                if func_name in self._tool_callables:
                    del self._tool_callables[func_name]   
                #移除 schema (重新生成一个不包含该 func_name 的列表)
                self._tool_schemas = [
                    schema for schema in self._tool_schemas if schema.get("function",{}).get("name") != func_name
                    ]
                #移除映射
                del self._module_to_tool_name[module_name]
            
            self._registered_modules.remove(module_name)
            logger.info(f"已成功卸载工具模块: {module_name} (关联工具名: {func_name})")
            
    def get_active_modules(self) -> List[str]:  #查看已激活的tool
        return list(self._registered_modules)
        
    def register(self,tools_path:str):    #将目录内所有符合要求的tools进行注册
        if not os.path.exists(tools_path):
            logger.warning(f"未查询到目录: {tools_path}")
            return
        for filename in os.listdir(tools_path):
            if filename.endswith(".py") and not filename.startswith("__"):
                module_name = filename[:-3]
                self.add_tool(module_name)
    
    def get_schema(self)->List[Dict]:
        return self._tool_schemas if self._tool_schemas else None

    async def execute(self,name:str,args:dict,agent=None)->Any:    #执行对应的tool并返回
        if name not in self._tool_callables:
            raise ValueError(f"Tool '{name}' is not registered in this registry.")
        func = self._tool_callables[name]
        
        sig = inspect.signature(func)   #检查传入函数的所需的参数列表，如果该工具需要 'agent' 参数就进行传递（其本身不接受这个参数，只是写了需要）
        if "agent" in sig.parameters and agent is not None:
            args["agent"] = agent   #将自身作为参数的一部分的特殊操作，这样llm就可以管理自身
        
        if inspect.iscoroutinefunction(func):
            return await func(**args)
        else:
            return await asyncio.to_thread(func, **args)

class PromptLoader:
    def __init__(self,base_dir:str=None):
        self.base_dir = base_dir or "base_prompt"
    
    async def get_base_prompt(self,session_type:str)->str|None:
        prompt_dir = os.path.join(self.base_dir,session_type)
        if not os.path.isdir(prompt_dir):
            logger.warning(f"Prompt 目录不存在: {prompt_dir}")
            return None
        
        md_files = sorted(
            [f for f in os.listdir(prompt_dir) if f.endswith(".md")]
        )
        if not md_files:
            logger.warning(f"{prompt_dir} 下未找到 .md 文件")
            return None
        
        parts = []
        for filename in md_files:
            file_path = os.path.join(prompt_dir,filename)
            try:
                async with aiofiles.open(file_path,"r",encoding="utf-8") as f:
                    content = await f.read()
                    parts.append(content)
                    logger.info(f"已加载 prompt 片段: {file_path}")
            except Exception as e:
                logger.exception(f"读取 {file_path} 失败: {e}")
        
        if not parts:
            return None
        return "\n\n".join(parts)
    
    async def read_skill(self,skill_path:str)->str|None:
        if not os.path.isfile(skill_path):
            logger.warning(f"Skill 文件不存在: {skill_path}")
            return None
        try:
            async with aiofiles.open(skill_path,"r",encoding="utf-8") as f:
                content = await f.read()
                logger.info(f"已读取 skill: {skill_path}")
                return content
        except Exception as e:
            logger.exception(f"读取 skill {skill_path} 失败: {e}")
            return None

current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
tools_dir = os.path.join(project_root,"tools")

BASE_TOOLS = ["tool_manager","bash_tool"] 
