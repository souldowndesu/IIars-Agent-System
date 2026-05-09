import asyncio
import json
import httpx

async def sse_event_iter(url:str=None):
    url = url or "http://127.0.0.1:8001/stream"
    while True:
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET",url) as response:   #stream方式获取迭代器,此时产生连接,broadcaster产生一个queue
                    async for line in response.aiter_lines():   #按行读取数据
                        if line.startswith("data:"):
                            data_str = line.split(":", 1)[1].strip()
                            data_str = line[6:].strip()
                            if not data_str:
                                continue    #抛弃空数据集
                            try:
                                event_data = json.loads(data_str)   #解析json为dict数据
                                yield event_data
                            except json.JSONDecodeError:
                                print(f"[解析错误] 无法解析数据: {data_str}")
                                continue
        except httpx.ConnectError:
            print("[Agent网络] LLM服务器未启动,5秒后自动重连...")
            await asyncio.sleep(5)
            
        except (httpx.ReadError, httpx.RemoteProtocolError):
            print("[Agent网络] 与 LLM 的连接意外断开,准备重连...")
            await asyncio.sleep(2)
            
        except Exception as e:
            # 捕获其他未知网络异常，防止迭代器崩溃
            print(f"[Agent网络] 网络流异常:{e},5秒后重试...")
            await asyncio.sleep(5)
            
                    