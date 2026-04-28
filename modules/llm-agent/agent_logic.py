from openai import OpenAI
import os
import json


class Agent:
    def __init__(self,api_key:str,base_url:str,model:str):
        self.client = OpenAI(api_key=api_key, base_url=base_url)
        self.model = model
        self.messages = []
        self.tools = []
        self.func_lib = {}

    def step(self,user_input:str=None)->dict:
        if user_input is not None:
            self.messages.append({"role":"user","content":user_input})
        response = self.client.chat.completions.create(
            model=self.model,
            messages=self.messages,
            tools=self.tools if self.tools else None,
            tool_choice="auto" if self.tools else "none"
        )
        response_msg = response.choices[0].message
        self.messages.append(response_msg)
        
        finish_res = response.choices[0].finish_reason
        tool_call = response_msg.tool_calls
        
    def add_tool(self,tool_json:dict,func:callable):
        self.tools.append(tool_json)
        func_name = tool_json["function"]["name"]
        self.func_lib[func_name] = func
        

        