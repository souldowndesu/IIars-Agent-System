from huggingface_hub import snapshot_download

# 1. 设置你想保存文件的本地根目录（请修改为你自己电脑上的实际路径）
local_save_path = r"D:\Data\VS_code\AI-workplace\my-agent\Genie"

print(f"准备将仓库拉取至: {local_save_path}")
print("自动开启断点续传，如果网络中断，重新运行此脚本即可...")

# 2. 调用下载 API
snapshot_download(
    repo_id="High-Logic/Genie",        # 官方仓库的 ID
    local_dir=local_save_path,         # 映射到本地的具体路径
    local_dir_use_symlinks=False       # Windows 系统必须设为 False，直接下载实体文件以避免软链接权限报错
)

print("🎉 下载全部完成！")