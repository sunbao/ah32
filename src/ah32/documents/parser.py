"""Bid document parser that extracts structured content."""

from __future__ import annotations

import logging
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Iterable, List

# 修复导入
from docx import Document as DocxDocument
from docx.document import Document as DocType
from docx.table import Table
from docx.text.paragraph import Paragraph
from docx.opc.exceptions import PackageNotFoundError
import zipfile

try:
    import win32com.client
    HAS_WIN32COM = True
except ImportError:
    HAS_WIN32COM = False

logger = logging.getLogger(__name__)

# Basic mapping between heading styles and the semantic level we care about.
HEADING_MAP = {
    "Heading 1": 1,
    "Heading 2": 2,
    "Heading 3": 3,
    "Heading 4": 4,
}


@dataclass
class DocumentSection:
    """Represents a logical slice of the tender document.

    Backwards-compatible with tests that construct using `id=...` or the
    internal code that uses `section_id` and `order`.
    """

    order: int = 0
    id: Optional[str] = None
    section_id: Optional[str] = None
    title: str = ""
    level: int = 0
    text: str = ""
    parent_id: Optional[str] = None
    raw_style: str = "Normal"
    formatting: dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        # Keep `id` and `section_id` in sync for compatibility
        if self.id and not self.section_id:
            self.section_id = self.id
        if self.section_id and not self.id:
            self.id = self.section_id


def _detect_level(paragraph: Paragraph) -> int:
    if paragraph.style and paragraph.style.name in HEADING_MAP:
        return HEADING_MAP[paragraph.style.name]
    match = re.match(r"^([0-9]+(?:\.[0-9]+)*)", paragraph.text.strip())
    if match:
        depth = match.group(1).count(".") + 1
        return min(depth, 6)
    return 0


def _split_heading(text: str) -> tuple[Optional[str], Optional[str]]:
    match = re.match(r"^(?P<id>[0-9一二三四五六七八九十\.]+)\s*(?P<title>.+)$", text)
    if match:
        return match.group("id"), match.group("title")
    return None, None


def _extract_table(table: Table) -> str:
    rows = []
    for row in table.rows:
        cells = [cell.text.strip() for cell in row.cells]
        if any(cells):
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def _iter_blocks(doc: DocType) -> Iterable[Paragraph | Table]:
    for element in doc.element.body:
        if element.tag.endswith("}tbl"):
            yield Table(element, doc)
        elif element.tag.endswith("}p"):
            yield Paragraph(element, doc)


class DocumentStructureParser:
    """Turns a DOCX file into ordered DocumentSection objects."""

    def __init__(self, include_tables: bool = True) -> None:
        self.include_tables = include_tables

    def _convert_doc_to_docx(self, doc_path: Path) -> Path:
        """将.doc格式转换为.docx格式"""
        if not HAS_WIN32COM:
            raise ValueError("需要安装pywin32库才能处理.doc格式文件")
        
        try:
            import win32com.client as win32
            word = win32.Dispatch("Word.Application")
            word.Visible = False
            word.DisplayAlerts = False
            
            # 打开.doc文件
            doc = word.Documents.Open(str(doc_path.absolute()))
            
            # 创建临时.docx文件
            temp_docx = tempfile.NamedTemporaryFile(suffix=".docx", delete=False)
            temp_docx.close()
            
            # 保存为.docx格式 (wdFormatXMLDocument = 12)
            doc.SaveAs(temp_docx.name, FileFormat=12)
            doc.Close()
            word.Quit()
            
            logger.info(f"已将.doc文件转换为临时.docx: {temp_docx.name}")
            return Path(temp_docx.name)
            
        except Exception as e:
            error_msg = f"转换.doc文件失败: {str(e)}"
            # 添加更详细的调试信息
            try:
                file_size = doc_path.stat().st_size if doc_path.exists() else 0
                error_msg += f" (文件大小: {file_size} 字节)"
            except Exception as e2:
                logger.debug(f"[docx] failed to stat file for error context: {e2}", exc_info=True)
            
            # 添加具体的异常类型信息
            error_msg += f" (异常类型: {type(e).__name__})"
            
            raise ValueError(error_msg)

    def parse(self, path: Path) -> List[DocumentSection]:
        # 检查文件格式，如果是.doc则先转换
        temp_file = None
        if path.suffix.lower() == ".doc":
            temp_file = self._convert_doc_to_docx(path)
            parse_path = temp_file
        else:
            parse_path = path
        
        try:
            doc = DocxDocument(str(parse_path))
        except PackageNotFoundError:
            raise ValueError(f"文件 {path} 不是有效的.docx文件或文件已损坏")
        except zipfile.BadZipFile:
            raise ValueError(f"文件 {path} 不是有效的ZIP文件，可能不是.docx格式或已损坏")
        except FileNotFoundError:
            raise ValueError(f"文件 {path} 未找到")
        except Exception as e:
            error_msg = f"解析文件 {path} 时发生错误"
            
            # 添加具体的异常类型信息
            error_msg += f" (异常类型: {type(e).__name__})"
            
            # 添加文件信息
            try:
                file_size = path.stat().st_size if path.exists() else 0
                error_msg += f" (文件大小: {file_size} 字节)"
            except Exception:
                error_msg += " (无法获取文件信息)"
            
            # 添加原始异常信息
            error_msg += f": {str(e)}"
            
            # 如果是特定类型的异常，提供更具体的建议
            if isinstance(e, PermissionError):
                error_msg += " - 请检查文件权限"
            elif isinstance(e, OSError):
                error_msg += " - 请检查磁盘空间和文件访问权限"
            elif isinstance(e, MemoryError):
                error_msg += " - 文件可能过大，建议分批处理"
            
            raise ValueError(error_msg)
        finally:
            # 清理临时文件
            if temp_file and temp_file.exists():
                try:
                    temp_file.unlink()
                except Exception as e:
                    logger.warning(f"[docx] temp file cleanup failed: {e}", exc_info=True)
            
        sections: list[DocumentSection] = []
        order = 0

        for block in _iter_blocks(doc):
            if isinstance(block, Paragraph):
                text = block.text.strip()
                if not text:
                    continue
                level = _detect_level(block)
                section_id, title = _split_heading(text)
                order += 1
                sections.append(
                    DocumentSection(
                        order=order,
                        section_id=section_id or f"sec-{order}",
                        title=title or text,
                        level=level,
                        text=text,
                        raw_style=(block.style.name if block.style else "Normal") or "Normal",
                        formatting={
                            "bold": str(any(run.bold for run in block.runs)),
                            "italic": str(any(run.italic for run in block.runs)),
                            "alignment": str(block.alignment),
                        },
                    )
                )
            elif isinstance(block, Table) and self.include_tables:
                table_text = _extract_table(block)
                if not table_text:
                    continue
                order += 1
                sections.append(
                    DocumentSection(
                        order=order,
                        section_id=f"table-{order}",
                        title=f"表格 {order}",
                        level=0,
                        text=table_text,
                        raw_style="Table",
                        formatting={"type": "table"},
                    )
                )

        return sections
