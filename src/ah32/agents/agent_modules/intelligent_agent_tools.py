"""阿蛤（AH32）智能 Agent 工具 - 保留通用功能"""

from typing import ClassVar
from langchain.tools import BaseTool as LangChainBaseTool
from pydantic import BaseModel, Field
import re
from pathlib import Path

from .base_agent_tools import BaseTool, ToolMetadata, ToolCategory, register_tool, get_synced_documents

logger = __import__('logging').getLogger(__name__)

@register_tool(ToolCategory.INTELLIGENCE, tags=["文档", "读取", "文件"], priority=10)
class ReadDocumentTool(BaseTool):
    """读取本地文档工具 - 支持多种格式"""

    name: str = "read_document"
    description: str = "读取本地文档文件（支持 .docx, .doc, .txt 等格式），提取文本内容和表格数据"
    category: str = "智能"

    # 工具元数据
    tool_metadata: ToolMetadata = ToolMetadata(
        name="read_document",
        description="读取本地文档文件，提取文本和表格内容",
        category="intelligence",
        tags=["文档", "读取", "文件"],
        priority=10,
        agentic_capable=True,
        llm_required=False,
        memory_required=False
    )

    # 支持的文件格式
    SUPPORTED_FORMATS: ClassVar[set[str]] = {'.docx', '.doc', '.wps', '.txt', '.md', '.pdf', '.rtf'}

    def _run(self, query: str = "") -> str:
        """同步执行 - 读取文档内容"""
        file_path = query.strip()

        # 空输入时显示使用说明
        if not file_path:
            return """
=== 读取文档工具 ===

使用方法：
1. 提供文档名（从同步列表中选择）：
   read_document("招标文件.docx")

2. 提供完整路径：
   read_document("D:/docs/招标文件.docx")
   read_document("D:\\\\docs\\\\招标文件.docx")

功能说明：
- 支持格式：.docx, .doc, .wps, .txt, .md, .pdf, .rtf
- 自动提取文本内容和表格
- 支持从 WPS 同步的文档列表中选择
- 自动处理编码问题（UTF-8, GBK 等）

注意事项：
- 确保文件已保存到本地
- 提供完整路径以避免歧义
            """.strip()

        # 如果是文档名（非完整路径），从同步文档列表匹配
        if not self._is_full_path(file_path):
            synced_docs = get_synced_documents()
            for doc in synced_docs:
                if doc.get("name") == file_path or doc.get("id") == file_path:
                    file_path = doc.get("path", "")
                    if file_path:
                        logger.info(f"从同步文档中找到: {doc.get('name')} -> {file_path}")
                    break
            else:
                # 没找到，返回可用文档列表
                docs_list = [doc.get("name") for doc in synced_docs]
                if docs_list:
                    return f"""
错误：未找到文档 '{query}'

可用文档：
{chr(10).join(f'- {name}' for name in docs_list)}

请使用完整文档名，如：read_document("{docs_list[0] if docs_list else ''}")
                    """.strip()
                return f"错误：没有同步的文档，请先在 WPS 中打开文档"

        return self._read_document(file_path)

    def _is_full_path(self, path: str) -> bool:
        """判断是否为完整路径"""
        return (
            path.startswith("/") or
            path.startswith("\\\\") or
            (len(path) >= 2 and path[1] == ":" and path[2] in "/\\")
        )

    def _read_document(self, file_path: str) -> str:
        """读取文档内容"""
        from pathlib import Path

        path = Path(file_path)

        # 检查文件是否存在
        if not path.exists():
            return f"错误：文件不存在\n路径：{file_path}"

        # 检查文件格式
        if path.suffix.lower() not in self.SUPPORTED_FORMATS:
            return f"错误：不支持的文件格式 '{path.suffix}'\n支持的格式：.docx, .doc, .txt, .md, .pdf, .rtf"

        try:
            suffix = path.suffix.lower()

            if suffix in ['.txt', '.md']:
                content = self._read_text_file(path)
            else:
                content = self._read_office_file(path)

            # 构建输出
            lines = []
            lines.append(f"=== 文档内容: {path.name} ===\n")

            # 统计
            char_count = len(content)
            line_count = content.count('\n') + 1
            table_count = content.count('[表格]')

            lines.append(f"【统计】字符: {char_count}, 行数: {line_count}")
            if table_count > 0:
                lines.append(f"表格数: {table_count}")
            lines.append(f"路径: {file_path}\n")

            lines.append("=" * 50)
            lines.append("")

            # 内容（限制长度避免输出过长）
            if char_count > 10000:
                lines.append(content[:10000])
                lines.append(f"\n... (共 {char_count} 字符，省略中间部分) ...\n")
                lines.append(content[-2000:])
            else:
                lines.append(content)

            lines.append("")
            lines.append("=" * 50)
            lines.append(f"读取完成：{path.name}")

            return "\n".join(lines)

        except Exception as e:
            logger.error(f"读取文档失败: {file_path}, 错误: {e}")
            return f"错误：读取失败 - {str(e)}"

    def _read_text_file(self, path: Path) -> str:
        """读取文本文件（支持多种编码）"""
        encodings = ['utf-8', 'gbk', 'gb2312', 'utf-16']

        for encoding in encodings:
            try:
                with open(path, 'r', encoding=encoding) as f:
                    return f.read()
            except (UnicodeDecodeError, UnicodeError):
                continue

        with open(path, 'rb') as f:
            return f.read().decode('utf-8', errors='ignore')

    def _read_office_file(self, path: Path) -> str:
        """读取 Office 文档"""
        suffix = path.suffix.lower()

        if suffix == '.docx':
            try:
                from docx import Document
                doc = Document(path)

                sections = []
                table_count = 0

                for element in doc.element.body:
                    if element.tag.endswith('}tbl'):
                        table_count += 1
                        table = self._extract_table_from_element(element, doc)
                        sections.append(f"[表格 {table_count}]")
                        sections.append("-" * 30)
                        sections.append(table)
                        sections.append("")
                    elif element.tag.endswith('}p'):
                        text = element.text.strip()
                        if text:
                            sections.append(text)

                return "\n".join(sections)
            except ImportError:
                return self._fallback_read(path)

        if suffix == '.doc':
            try:
                import win32com.client as win32
                word = win32.Dispatch("Word.Application")
                word.Visible = False
                try:
                    doc = word.Documents.Open(str(path.absolute()))
                    content = doc.Content.Text
                    doc.Close()
                    return content
                finally:
                    word.Quit()
            except Exception as e:
                logger.warning(f"[read] Word COM open failed for {path}: {e}", exc_info=True)
                return self._fallback_read(path)

        if suffix == '.wps':
            # WPS 文字文档
            # 方式1：尝试使用 WPS COM 接口
            try:
                import win32com.client as win32
                wps = win32.Dispatch("KWPS.Application")
                wps.Visible = False
                try:
                    doc = wps.Documents.Open(str(path.absolute()))
                    content = doc.Content.Text
                    doc.Close()
                    return content
                finally:
                    wps.Quit()
            except Exception as e:
                logger.warning(f"[read] WPS COM open failed for {path}: {e}", exc_info=True)

            # 方式2：尝试用 Word 打开 WPS 文件（Word 可以直接打开 .wps）
            try:
                import win32com.client as win32
                word = win32.Dispatch("Word.Application")
                word.Visible = False
                try:
                    doc = word.Documents.Open(str(path.absolute()))
                    content = doc.Content.Text
                    doc.Close()
                    return content
                finally:
                    word.Quit()
            except Exception as e:
                logger.warning(f"[read] Word COM open (.wps) failed for {path}: {e}", exc_info=True)

            # 方式3：尝试使用 mammoth 库转换
            try:
                import mammoth
                with open(path, 'rb') as f:
                    result = mammoth.convert_to_html(f)
                    # 提取纯文本部分
                    import re
                    text = re.sub(r'<[^>]+>', '', result.value)
                    return text
            except Exception as e:
                logger.warning(f"[read] mammoth conversion failed for {path}: {e}", exc_info=True)

            return self._fallback_read(path)

        return self._fallback_read(path)

    def _extract_table_from_element(self, element, doc) -> str:
        """从 DOCX 元素中提取表格内容"""
        try:
            from docx.table import Table
            table = Table(element, doc)
            rows = []
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells]
                if any(cells):
                    rows.append(" | ".join(cells))
            return "\n".join(rows)
        except Exception:
            return "[表格提取失败]"

    def _fallback_read(self, path: Path) -> str:
        """备用读取方法"""
        try:
            with open(path, 'rb') as f:
                binary_data = f.read()

            text = ''.join(chr(b) if 32 <= b <= 126 else '\n' for b in binary_data)
            import re
            text = re.sub(r'\n{3,}', '\n\n', text)
            text = text.strip()

            if len(text) > 100:
                return text[:5000] + ("\n... (内容截断) ..." if len(text) > 5000 else "")
            return "[无法提取文本内容]"
        except Exception as e:
            return f"[读取失败: {str(e)}]"

    async def _arun(self, query: str = "") -> str:
        """异步执行"""
        return self._run(query)
