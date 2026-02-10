"""Embedding resolution utilities."""

from __future__ import annotations
import os
import logging
from pathlib import Path

try:
    from langchain_openai import OpenAIEmbeddings
except ImportError:  # pragma: no cover - langchain-openai optional during bootstrap
    OpenAIEmbeddings = None  # type: ignore

try:
    from langchain_huggingface import HuggingFaceEmbeddings
except ImportError:  # pragma: no cover - huggingface_hub optional during bootstrap
    HuggingFaceEmbeddings = None  # type: ignore

# 修改为绝对导入
from ah32.config import Ah32Settings

from langchain_core.embeddings import Embeddings
import sys

logger = logging.getLogger(__name__)


def get_model_cache_dir(settings: Ah32Settings) -> str:
    """获取模型缓存目录路径，兼容exe运行时"""
    # 检查是否在exe中运行
    if getattr(sys, 'frozen', False):
        # exe运行时，使用exe所在目录下的models文件夹
        executable_dir = Path(sys.executable).parent
        cache_dir = executable_dir / "models"
    else:
        # 开发时，使用配置中的storage_root
        # 但是需要确保相对路径是从项目根目录计算的
        storage_root = settings.storage_root

        # 如果storage_root是相对路径，尝试从项目根目录解析
        if not storage_root.is_absolute():
            # 获取当前文件的目录
            current_file_dir = Path(__file__).parent  # src/ah32/knowledge
            # 向上查找直到找到项目根目录（包含.env的目录）
            project_root = current_file_dir
            for _ in range(5):  # 最多向上5级
                if (project_root / ".env").exists():
                    break
                project_root = project_root.parent

            # 如果找到.env文件，说明找到了项目根目录
            if (project_root / ".env").exists():
                storage_root = project_root / storage_root
            else:
                # 没找到，使用当前工作目录
                storage_root = Path.cwd() / storage_root

        cache_dir = storage_root / 'models'

    return str(cache_dir)


def download_embedding_model(settings: Ah32Settings) -> bool:
    """Download the embedding model if not exists."""
    try:
        # 临时设置在线模式以允许下载
        os.environ['HF_HUB_OFFLINE'] = '0'
        os.environ['TRANSFORMERS_OFFLINE'] = '0'
        
        # 确保缓存目录存在
        cache_dir = str(settings.storage_root / 'models')
        os.makedirs(cache_dir, exist_ok=True)
        
        # 尝试加载模型（这会触发下载）
        model_name = settings.embedding_model
        logger.info(f"正在下载嵌入模型: {model_name}")
        
        # 初始化模型（触发下载）
        model_kwargs = {
            'device': 'cpu',  # 下载时使用CPU
            'trust_remote_code': False
        }
        encode_kwargs = {
            'normalize_embeddings': True
        }
        
        embedding = HuggingFaceEmbeddings(
            model_name=model_name,
            model_kwargs=model_kwargs,
            encode_kwargs=encode_kwargs,
            cache_folder=cache_dir
        )
        
        # 测试模型是否可以正常使用
        test_embedding = embedding.embed_query("测试句子")
        logger.info(f"模型下载成功，嵌入维度: {len(test_embedding)}")
        
        # 恢复离线模式
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        
        return True
    except Exception as e:
        logger.error(f"模型下载失败: {e}")
        # 恢复离线模式
        os.environ['HF_HUB_OFFLINE'] = '1'
        os.environ['TRANSFORMERS_OFFLINE'] = '1'
        return False


# 嵌入模型缓存
_embedding_instance = None
_embedding_cache_key = None


def check_embedding_model_ready(settings: Ah32Settings) -> tuple[bool, str]:
    """Preflight check for embedding model availability.

    This is designed for "offline-first" deployments: when offline mode is enabled,
    we want a clear, actionable error if the embedding model isn't fully present in
    the local cache.

    Returns:
        (ok, message)
    """
    target = settings.embedding_model

    # OpenAI embedding models are remote by design; nothing to check locally.
    if target.startswith("text-embedding-"):
        return True, f"embedding_model={target} (remote)"

    if HuggingFaceEmbeddings is None:
        return False, "langchain-huggingface is not installed; cannot use local embeddings"

    cache_dir = get_model_cache_dir(settings)
    model_path = Path(cache_dir) / f"models--{target.replace('/', '--')}"

    if not model_path.exists():
        return (
            False,
            (
                f"embedding_model={target} not found in local cache: {model_path}. "
                "Run: `python src/ah32/download_models.py` (with HF_HUB_OFFLINE=0 / TRANSFORMERS_OFFLINE=0 once)."
            ),
        )

    snapshots_dir = model_path / "snapshots"
    if not snapshots_dir.exists():
        return False, f"embedding_model cache is missing snapshots dir: {snapshots_dir}"

    snapshots = [p for p in snapshots_dir.iterdir() if p.is_dir()]
    if not snapshots:
        return False, f"embedding_model cache has no snapshots: {snapshots_dir}"

    # Prefer a snapshot that has SentenceTransformer metadata.
    def _is_complete_snapshot(p: Path) -> bool:
        return (p / "modules.json").exists() or (p / "config_sentence_transformers.json").exists()

    complete = [s for s in snapshots if _is_complete_snapshot(s)]
    if not complete:
        # A common failure mode on Windows is having only weights (model.safetensors) but no tokenizer/config.
        return (
            False,
            (
                f"embedding_model cache snapshots look incomplete under: {snapshots_dir}. "
                "Please re-run `python src/ah32/download_models.py` while online, and ensure it completes without errors."
            ),
        )

    complete.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return True, f"embedding_model={target} ready (snapshot={complete[0]})"


def resolve_embedding(settings: Ah32Settings) -> Embeddings:
    """Resolve the embedding model based on settings."""
    global _embedding_instance, _embedding_cache_key

    # 生成缓存键（基于模型名称和设备）
    cache_key = f"{settings.embedding_model}:{settings.get_embedding_device()}"
    logger.debug(f"开始解析嵌入模型，缓存键: {cache_key}")

    # 如果已有缓存的实例且缓存键匹配，直接返回
    if _embedding_instance is not None and _embedding_cache_key == cache_key:
        logger.debug("使用缓存的嵌入模型实例")
        return _embedding_instance

    target = settings.embedding_model
    logger.debug(f"目标嵌入模型: {target}")

    if target.startswith("text-embedding-"):
        # Likely OpenAI embedding models
        if OpenAIEmbeddings is not None:
            logger.debug("使用 OpenAI 嵌入模型")
            _embedding_instance = OpenAIEmbeddings(model=target)
            _embedding_cache_key = cache_key
            logger.info(f"OpenAI 嵌入模型初始化完成: {target}")
            return _embedding_instance

    if HuggingFaceEmbeddings is not None:
        # 获取模型缓存目录路径（兼容exe运行时）
        logger.debug("使用 HuggingFace 嵌入模型")
        cache_dir = get_model_cache_dir(settings)
        model_path = Path(cache_dir) / f"models--{target.replace('/', '--')}"

        # 记录模型路径信息
        logger.info(f"模型缓存目录: {cache_dir}")
        logger.info(f"模型路径: {model_path}")

        # 检查模型是否存在
        if not model_path.exists():
            logger.debug(f"模型文件不存在: {model_path}")

            # exe运行时如果模型不存在，提供更友好的错误信息
            if getattr(sys, 'frozen', False):
                logger.error(f"嵌入模型 {target} 未找到（exe模式）")
                raise FileNotFoundError(
                    f"嵌入模型 {target} 未找到！\n"
                    f"请确保已将预下载的模型文件放置在以下目录中：\n"
                    f"{cache_dir}\n"
                    f"可以使用 python src/ah32/download_models.py 下载模型"
                )
            else:
                logger.info(f"嵌入模型 {target} 未找到，尝试下载...")
                if not download_embedding_model(settings):
                    raise ValueError(f"无法下载嵌入模型 {target}，请检查网络连接或手动放置模型文件到 {cache_dir}")
        else:
            logger.debug(f"模型文件存在: {model_path}")

        # 使用配置的设备（GPU或CPU）
        device = settings.get_embedding_device()

        # 设置缓存路径和模型参数
        model_kwargs = {
            'device': device,
            'trust_remote_code': False
        }
        encode_kwargs = {
            'normalize_embeddings': True
        }

        # 确保使用本地缓存目录
        os.makedirs(cache_dir, exist_ok=True)

        # 记录设备信息
        logger.info(f"使用嵌入模型设备: {device}")
        logger.info(f"模型名称: {target}")

        # 如果启用了离线模式，尽量使用本地 snapshot 路径加载，避免 transformers/huggingface_hub
        # 在某些版本下仍会尝试访问 model_info()。
        model_name_or_path = target
        try:
            offline = os.environ.get("HF_HUB_OFFLINE") == "1" or os.environ.get("TRANSFORMERS_OFFLINE") == "1"
            if offline and model_path.exists():
                snapshots_dir = model_path / "snapshots"
                if snapshots_dir.exists():
                    snapshots = [p for p in snapshots_dir.iterdir() if p.is_dir()]
                    if snapshots:
                        snapshots.sort(key=lambda p: p.stat().st_mtime, reverse=True)

                        # Prefer a "complete" snapshot directory. Some Windows setups may end up
                        # with an extra snapshot containing only a large weights file (e.g. model.safetensors)
                        # but missing tokenizer/config; SentenceTransformer cannot load from that.
                        def _is_complete_snapshot(p: Path) -> bool:
                            return (p / "modules.json").exists() or (p / "config_sentence_transformers.json").exists()

                        chosen = None
                        for s in snapshots:
                            if _is_complete_snapshot(s):
                                chosen = s
                                break
                        if chosen is None:
                            chosen = snapshots[0]

                        model_name_or_path = str(chosen)
                        logger.info(f"离线模式：使用本地模型 snapshot 加载: {model_name_or_path}")
        except Exception as e:
            logger.debug(f"离线模式本地加载探测失败，将回退为模型ID: {e}")

        logger.debug("初始化 HuggingFace 嵌入模型")
        _embedding_instance = HuggingFaceEmbeddings(
            model_name=model_name_or_path,
            model_kwargs=model_kwargs,
            encode_kwargs=encode_kwargs,
            cache_folder=cache_dir  # 使用本地缓存
        )

        logger.info(f"嵌入模型初始化完成，使用缓存目录: {cache_dir}")

        _embedding_cache_key = cache_key
        return _embedding_instance

    # Fallback
    logger.error("未找到合适的嵌入模型")
    raise ValueError("No suitable embedding model found. Please install langchain-openai or langchain-huggingface.")
