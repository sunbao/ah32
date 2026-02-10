"""Ah32 性能监控和优化工具

监控文档处理性能，提供优化建议。
"""

import time
import psutil
import asyncio
from typing import Dict, Any, List, Optional, Callable
from dataclasses import dataclass, field
from collections import defaultdict
import logging

logger = logging.getLogger(__name__)


@dataclass
class PerformanceMetrics:
    """性能指标"""

    # 时间指标
    start_time: float = 0.0
    end_time: float = 0.0
    duration: float = 0.0

    # 内存指标
    memory_start: float = 0.0
    memory_end: float = 0.0
    memory_peak: float = 0.0
    memory_delta: float = 0.0

    # 处理指标
    documents_processed: int = 0
    chunks_generated: int = 0
    bytes_processed: int = 0

    # 质量指标
    success_rate: float = 0.0
    error_count: int = 0

    # 系统指标
    cpu_percent: float = 0.0
    io_read_mb: float = 0.0
    io_write_mb: float = 0.0

    def calculate_metrics(self):
        """计算性能指标"""
        self.duration = self.end_time - self.start_time
        self.memory_delta = self.memory_end - self.memory_start

    def get_summary(self) -> Dict[str, Any]:
        """获取性能摘要"""
        return {
            "duration_seconds": round(self.duration, 3),
            "memory_usage_mb": round(self.memory_delta / 1024 / 1024, 2),
            "memory_peak_mb": round(self.memory_peak / 1024 / 1024, 2),
            "documents_per_second": round(self.documents_processed / max(self.duration, 0.001), 2),
            "chunks_per_second": round(self.chunks_generated / max(self.duration, 0.001), 2),
            "mb_per_second": round(self.bytes_processed / 1024 / 1024 / max(self.duration, 0.001), 2),
            "success_rate": round(self.success_rate * 100, 1),
            "cpu_percent": round(self.cpu_percent, 1)
        }


class PerformanceMonitor:
    """性能监控器"""

    def __init__(self, enable_system_metrics: bool = True):
        """初始化性能监控器

        Args:
            enable_system_metrics: 是否启用系统指标监控
        """
        self.enable_system_metrics = enable_system_metrics
        self.metrics_history: List[PerformanceMetrics] = []
        self.current_metrics: Optional[PerformanceMetrics] = None
        self.process = psutil.Process()

        # 性能阈值配置
        self.thresholds = {
            "max_duration_seconds": 300,  # 5分钟
            "max_memory_mb": 2048,       # 2GB
            "min_success_rate": 0.95,     # 95%
            "min_documents_per_second": 0.1,  # 每秒0.1个文档
        }

    def start_monitoring(self, operation_name: str = "unknown") -> str:
        """开始监控

        Args:
            operation_name: 操作名称

        Returns:
            监控ID
        """
        metrics = PerformanceMetrics()
        metrics.start_time = time.time()

        if self.enable_system_metrics:
            metrics.memory_start = self.process.memory_info().rss
            metrics.cpu_percent = self.process.cpu_percent()

            # 获取IO统计
            try:
                io_counters = self.process.io_counters()
                metrics.io_read_mb = io_counters.read_bytes / 1024 / 1024
                metrics.io_write_mb = io_counters.write_bytes / 1024 / 1024
            except (AttributeError, psutil.AccessDenied):
                pass

        self.current_metrics = metrics
        self._monitoring_id = f"{operation_name}_{int(metrics.start_time)}"

        logger.debug(f"开始性能监控: {self._monitoring_id}")
        return self._monitoring_id

    def end_monitoring(self, success: bool = True, error: Optional[str] = None):
        """结束监控

        Args:
            success: 操作是否成功
            error: 错误信息
        """
        if not self.current_metrics:
            logger.warning("没有活动的监控会话")
            return

        metrics = self.current_metrics
        metrics.end_time = time.time()

        if self.enable_system_metrics:
            metrics.memory_end = self.process.memory_info().rss
            metrics.memory_peak = max(metrics.memory_start, metrics.memory_end)

            # 更新CPU使用率
            if metrics.cpu_percent > 0:
                metrics.cpu_percent = self.process.cpu_percent(interval=None)

        metrics.error_count = 0 if success else 1
        metrics.calculate_metrics()

        # 添加到历史记录
        self.metrics_history.append(metrics)

        # 清理当前监控
        self.current_metrics = None

        # 记录性能日志
        summary = metrics.get_summary()
        status = "成功" if success else "失败"
        logger.info(f"性能监控完成 {self._monitoring_id}: {status}, {summary}")

        # 检查性能告警
        self._check_performance_alerts(summary)

    def update_processed_count(self, documents: int = 0, chunks: int = 0, bytes_processed: int = 0):
        """更新处理计数

        Args:
            documents: 处理的文档数
            chunks: 生成的块数
            bytes_processed: 处理的字节数
        """
        if self.current_metrics:
            self.current_metrics.documents_processed += documents
            self.current_metrics.chunks_generated += chunks
            self.current_metrics.bytes_processed += bytes_processed

    def get_current_metrics(self) -> Optional[PerformanceMetrics]:
        """获取当前监控指标"""
        return self.current_metrics

    def get_history_summary(self, limit: int = 10) -> Dict[str, Any]:
        """获取历史性能摘要

        Args:
            limit: 返回的记录数限制

        Returns:
            历史性能摘要
        """
        recent_metrics = self.metrics_history[-limit:] if self.metrics_history else []

        if not recent_metrics:
            return {"message": "没有性能历史记录"}

        # 计算聚合统计
        total_operations = len(recent_metrics)
        total_duration = sum(m.duration for m in recent_metrics)
        total_documents = sum(m.documents_processed for m in recent_metrics)
        total_chunks = sum(m.chunks_generated for m in recent_metrics)
        total_errors = sum(m.error_count for m in recent_metrics)
        avg_memory = sum(m.memory_delta for m in recent_metrics) / len(recent_metrics)

        success_rate = (total_operations - total_errors) / max(total_operations, 1)

        return {
            "total_operations": total_operations,
            "total_duration_seconds": round(total_duration, 3),
            "total_documents": total_documents,
            "total_chunks": total_chunks,
            "average_duration_seconds": round(total_duration / max(total_operations, 1), 3),
            "average_documents_per_second": round(total_documents / max(total_duration, 0.001), 2),
            "average_memory_mb": round(avg_memory / 1024 / 1024, 2),
            "success_rate": round(success_rate * 100, 1),
            "error_count": total_errors
        }

    def _check_performance_alerts(self, summary: Dict[str, Any]):
        """检查性能告警

        Args:
            summary: 性能摘要
        """
        alerts = []

        # 检查执行时间
        if summary["duration_seconds"] > self.thresholds["max_duration_seconds"]:
            alerts.append(f"执行时间过长: {summary['duration_seconds']}秒 > {self.thresholds['max_duration_seconds']}秒")

        # 检查内存使用
        if summary["memory_usage_mb"] > self.thresholds["max_memory_mb"]:
            alerts.append(f"内存使用过高: {summary['memory_usage_mb']}MB > {self.thresholds['max_memory_mb']}MB")

        # 检查成功率
        if summary["success_rate"] < self.thresholds["min_success_rate"] * 100:
            alerts.append(f"成功率过低: {summary['success_rate']}% < {self.thresholds['min_success_rate'] * 100}%")

        # 检查处理速度
        if summary["documents_per_second"] < self.thresholds["min_documents_per_second"]:
            alerts.append(f"处理速度过慢: {summary['documents_per_second']} < {self.thresholds['min_documents_per_second']} 文档/秒")

        # 记录告警
        for alert in alerts:
            logger.warning(f"性能告警: {alert}")

    def get_optimization_suggestions(self) -> List[str]:
        """获取优化建议

        Returns:
            优化建议列表
        """
        suggestions = []

        if not self.metrics_history:
            return ["开始监控以获取优化建议"]

        recent_metrics = self.metrics_history[-20:]  # 最近20次操作
        summary = self.get_history_summary()

        # 基于历史数据的优化建议

        # 内存优化
        avg_memory_mb = summary.get("average_memory_mb", 0)
        if avg_memory_mb > 1024:  # 超过1GB
            suggestions.append(
                "建议启用文档流式处理或增加分块大小以减少内存使用"
            )
            suggestions.append(
                "考虑使用更小的batch_size进行批量处理"
            )

        # 速度优化
        avg_duration = summary.get("average_duration_seconds", 0)
        if avg_duration > 10:  # 平均超过10秒
            suggestions.append(
                "建议使用更快的文档加载器（如Unstructured）"
            )
            suggestions.append(
                "考虑启用并行处理或增加工作进程数"
            )

        # 成功率优化
        success_rate = summary.get("success_rate", 100)
        if success_rate < 95:
            suggestions.append(
                "错误率较高，建议检查文件格式支持和错误处理机制"
            )
            suggestions.append(
                "考虑添加文件验证和重试机制"
            )

        # 文档处理速度优化
        docs_per_sec = summary.get("average_documents_per_second", 0)
        if docs_per_sec < 1:
            suggestions.append(
                "文档处理速度较慢，建议使用缓存或预加载"
            )

        return suggestions

    def benchmark_document_loader(self, test_files: List[str], loader_func: Callable) -> Dict[str, Any]:
        """基准测试文档加载器

        Args:
            test_files: 测试文件列表
            loader_func: 加载器函数

        Returns:
            基准测试结果
        """
        results = {
            "files_tested": len(test_files),
            "successful_loads": 0,
            "failed_loads": 0,
            "total_size_mb": 0,
            "total_time_seconds": 0,
            "load_times": [],
            "errors": []
        }

        for file_path in test_files:
            if not os.path.exists(file_path):
                results["errors"].append(f"文件不存在: {file_path}")
                continue

            file_size = os.path.getsize(file_path)
            results["total_size_mb"] += file_size / 1024 / 1024

            start_time = time.time()
            try:
                # 这里需要根据实际的loader_func调整
                # 暂时模拟加载过程
                asyncio.run(loader_func(file_path))
                load_time = time.time() - start_time

                results["load_times"].append(load_time)
                results["successful_loads"] += 1

            except Exception as e:
                results["failed_loads"] += 1
                results["errors"].append(f"加载失败 {file_path}: {str(e)}")

        # 计算统计
        if results["load_times"]:
            results["average_load_time"] = sum(results["load_times"]) / len(results["load_times"])
            results["min_load_time"] = min(results["load_times"])
            results["max_load_time"] = max(results["load_times"])
            results["files_per_second"] = results["successful_loads"] / sum(results["load_times"])
        else:
            results["average_load_time"] = 0
            results["min_load_time"] = 0
            results["max_load_time"] = 0
            results["files_per_second"] = 0

        results["total_time_seconds"] = sum(results["load_times"])
        results["total_size_mb"] = round(results["total_size_mb"], 2)

        return results


class AsyncPerformanceMonitor:
    """异步性能监控器"""

    def __init__(self, monitor: PerformanceMonitor):
        """初始化异步监控器

        Args:
            monitor: 基础性能监控器
        """
        self.monitor = monitor

    async def monitor_async_operation(self, operation_name: str, operation_func: Callable, *args, **kwargs):
        """监控异步操作

        Args:
            operation_name: 操作名称
            operation_func: 异步操作函数
            *args: 操作参数
            **kwargs: 操作关键字参数

        Returns:
            操作结果
        """
        monitor_id = self.monitor.start_monitoring(operation_name)

        try:
            # 执行异步操作
            result = await operation_func(*args, **kwargs)
            self.monitor.end_monitoring(success=True)
            return result

        except Exception as e:
            self.monitor.end_monitoring(success=False, error=str(e))
            raise


# 全局性能监控实例
_global_monitor: Optional[PerformanceMonitor] = None


def get_performance_monitor() -> PerformanceMonitor:
    """获取全局性能监控器

    Returns:
        性能监控器实例
    """
    global _global_monitor
    if _global_monitor is None:
        _global_monitor = PerformanceMonitor()
    return _global_monitor


def reset_performance_monitor():
    """重置全局性能监控器"""
    global _global_monitor
    _global_monitor = None


# 装饰器
def performance_monitor(operation_name: str = None):
    """性能监控装饰器

    Args:
        operation_name: 操作名称，如果不提供则使用函数名
    """
    def decorator(func):
        async def async_wrapper(*args, **kwargs):
            monitor = get_performance_monitor()
            monitor_id = monitor.start_monitoring(operation_name or func.__name__)

            try:
                result = await func(*args, **kwargs)
                monitor.end_monitoring(success=True)
                return result
            except Exception as e:
                monitor.end_monitoring(success=False, error=str(e))
                raise

        def sync_wrapper(*args, **kwargs):
            monitor = get_performance_monitor()
            monitor_id = monitor.start_monitoring(operation_name or func.__name__)

            try:
                result = func(*args, **kwargs)
                monitor.end_monitoring(success=True)
                return result
            except Exception as e:
                monitor.end_monitoring(success=False, error=str(e))
                raise

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator


# 便捷函数
def start_performance_monitoring(operation_name: str = "operation") -> str:
    """开始性能监控

    Args:
        operation_name: 操作名称

    Returns:
        监控ID
    """
    monitor = get_performance_monitor()
    return monitor.start_monitoring(operation_name)


def end_performance_monitoring(success: bool = True, error: Optional[str] = None):
    """结束性能监控

    Args:
        success: 操作是否成功
        error: 错误信息
    """
    monitor = get_performance_monitor()
    monitor.end_monitoring(success, error)


def get_performance_summary() -> Dict[str, Any]:
    """获取性能摘要

    Returns:
        性能摘要
    """
    monitor = get_performance_monitor()
    return monitor.get_history_summary()


def get_optimization_recommendations() -> List[str]:
    """获取优化建议

    Returns:
        优化建议列表
    """
    monitor = get_performance_monitor()
    return monitor.get_optimization_suggestions()
