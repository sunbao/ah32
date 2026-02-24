#!/usr/bin/env python3

# -*- coding: utf-8 -*-

"""

Ah32 launcher with configuration checking and model download support."""



import sys

import os

from pathlib import Path

import subprocess

import logging



from ah32.runtime_paths import runtime_root



# 设置日志
_reconfigure_exc_info = None
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    _reconfigure_exc_info = sys.exc_info()

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(filename)s:%(lineno)d - %(message)s',
    handlers=[
        logging.FileHandler("ah32_launcher.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout)
    ]
)

logger = logging.getLogger(__name__)

if _reconfigure_exc_info:
    logger.warning(
        "[launcher] stdout/stderr reconfigure failed (ignored)", exc_info=_reconfigure_exc_info
    )
    _reconfigure_exc_info = None





def can_interact():

    """检查是否在可交互环境中运行（是否有stdin）"""

    try:

        # 检查是否有有效的stdin

        if hasattr(sys.stdin, 'isatty') and sys.stdin.isatty():

            return True

        # 如果是PyInstaller打包的exe且没有控制台，返回False

        if getattr(sys, 'frozen', False):

            return False

        return True

    except Exception:

        logger.debug("[launcher] can_interact probe failed (ignored)", exc_info=True)
        return False





def wait_for_user_exit(message="按回车键退出..."):

    """等待用户退出"""

    if can_interact():

        try:

            input(message)

        except Exception as e:

            logger.debug(f"等待用户输入失败: {e}", exc_info=True)

    else:

        # exe中不可交互，直接等待一小段时间让用户看到错误信息

        import time

        logger.info("[启动器] 程序将在3秒后退出...")

        time.sleep(3)





def load_env_strict() -> Path:
    """Load .env strictly (must exist and include AH32_EMBEDDING_MODEL)."""
    try:
        from dotenv import load_dotenv
    except ImportError as e:
        raise RuntimeError("python-dotenv is required to load .env; please install it.") from e

    env_file = runtime_root() / ".env"
    if not env_file.exists():
        raise RuntimeError(f".env file not found: {env_file}. Create it in the repo root.")

    load_dotenv(env_file, override=True)
    if not os.environ.get("AH32_EMBEDDING_MODEL"):
        raise RuntimeError("AH32_EMBEDDING_MODEL is missing in .env; please configure it.")

    return env_file


def init_environment():
    """Log environment (no fallback defaults)."""
    logger.info(f"[环境初始化] HF_HUB_OFFLINE={os.environ.get('HF_HUB_OFFLINE')}")
    logger.info(f"[环境初始化] TRANSFORMERS_OFFLINE={os.environ.get('TRANSFORMERS_OFFLINE')}")
    logger.info(f"[环境初始化] HF_DATASETS_OFFLINE={os.environ.get('HF_DATASETS_OFFLINE')}")


def load_config_and_check_model():

    """加载配置并检查模型"""

    logger.info("[模型检查] 开始检查嵌入模型...")

    try:

        # 添加项目根目录到Python路径

        project_root = Path(__file__).parent.parent

        sys.path.insert(0, str(project_root))

        

        # 导入配置和嵌入模块

        from ah32.config import settings

        from ah32.knowledge.embeddings import resolve_embedding

        

        logger.info("[模型检查] 配置加载成功")

        logger.info(f"[模型检查] 存储根目录: {settings.storage_root}")

        logger.info(f"[模型检查] 嵌入模型: {settings.embedding_model}")

        logger.info(f"[模型检查] LLM模型: {settings.llm_model}")

        

        # 尝试解析嵌入模型

        embedding = resolve_embedding(settings)

        logger.info("[模型检查] 嵌入模型解析成功")

        return True

    except Exception as e:

        logger.error(f"[模型检查] 嵌入模型解析失败: {e}", exc_info=True)

        return False



def main():

    """启动器主函数"""

    logger.info("[启动器] Ah32 启动器开始运行")

    

    # Load .env strictly
    try:
        env_file = load_env_strict()
        logger.info(f"[启动器] 已加载配置: {env_file}")
    except Exception as e:
        logger.error(f"[启动器] .env 加载失败: {e}", exc_info=True)
        wait_for_user_exit()
        return

    # 初始化环境变量（仅记录，不做兜底）
    init_environment()

    

    # 加载配置并检查模型

    logger.info("[启动器] 开始加载配置并检查模型...")

    if not load_config_and_check_model():

        logger.error("[启动器] 模型检查失败，无法启动主程序")

        wait_for_user_exit()

        return

    

    # 启动主程序

    logger.info("[启动器] 启动主程序...")

    try:

        # 获取当前脚本所在目录

        current_dir = Path(__file__).parent

        server_script = current_dir / "server" / "main.py"

        

        logger.info(f"[启动器] 主程序路径: {server_script}")

        

        # 使用 subprocess 启动主程序

        process = subprocess.Popen([

            sys.executable, 

            str(server_script)

        ], cwd=current_dir.parent)

        

        logger.info(f"[启动器] 主程序已启动，PID: {process.pid}")

        process.wait()

        

    except Exception as e:

        logger.error(f"[启动器] 启动主程序时发生错误: {e}", exc_info=True)

        wait_for_user_exit()



if __name__ == "__main__":

    main()

