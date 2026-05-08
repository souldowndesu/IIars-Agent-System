import asyncio
import dotenv

from chat import AsyncLLM
from tts import init_genie_async,GenieWorker,AudioPlayer,sentence_chunker

dotenv.load_dotenv()

async def main():
    onnx_path = r"D:\Data\VS_code\AI-workplace\may-agent\Genie\CharacterModels\v2ProPlus\thirtyseven\tts_models"
    ref_audio_path = r"D:\Data\VS_code\AI-workplace\may-agent\Genie\CharacterModels\v2ProPlus\thirtyseven\prompt_wav\En_play_hero3066_fightingvoc_19.wav"
    ref_text = "And now, I belong to this set."
    init_genie_async(chara_name="37",onnx_dir=onnx_path,ref_audio_pth=ref_audio_path,ref_text=ref_text,lang="en")
    player = AudioPlayer()
    tts_worker = GenieWorker(player)
    llm = AsyncLLM()
    
    print("推理开始，输入“quit”或“exit”退出")
    await tts_worker.start()
    
    while True:
        src = input("你:")
        if src.lower() in ["quit","exit"]:
            break
        word_stream = await llm.chat_stream(src)
        sentence_iter = await sentence_chunker(word_stream=word_stream)
        async for sentence in sentence_iter:
            if sentence:
                await tts_worker.speak(sentence=sentence,chara_name="37")
        await tts_worker.wait_finish() #停留至完成语音播放
    await tts_worker.close()
    player.close()

if __name__ == "__main__":
    asyncio.run(main())
    