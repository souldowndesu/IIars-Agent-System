from openai import AsyncOpenAI
import dotenv,os
import asyncio
dotenv.load_dotenv()

class AsyncLLM:
    def __init__(self,api_key:str=None,model:str=None,base_url:str=None):
        self.client = AsyncOpenAI(
            api_key=api_key or os.getenv("API_KEY"),
            base_url=base_url or os.getenv("BASE_URL")
            )
        self.model = model or os.getenv("MODEL")
        
        self.messages = [{"role":"system","content":"You are a assistant,you should reply in english,and should not use emoji or special icons/characters"}]
        
    async def chat_stream(self,user_input:str,message:dict=None):
        if not message:
            self.messages.append({"role":"user","content":user_input})
        else:
            self.messages.append(message)
        resp = await self.client.chat.completions.create(
            model=self.model,
            messages=self.messages,
            stream=True
        )
        
        full_reply = ""
        async for chunk in resp:
            if chunk.choices[0].delta.content:
                word = chunk.choices[0].delta.content
                full_reply += word
                yield word
                
        self.messages.append({"role":"assistant","content":full_reply})

