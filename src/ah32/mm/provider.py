from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class AnalysisResult:
    text: str
    provider: str
    model: str


@dataclass(frozen=True)
class GeneratedImage:
    image_bytes: bytes
    mime: str
    provider: str
    model: str


class MultimodalProvider(Protocol):
    name: str

    async def analyze_image(
        self,
        *,
        prompt: str,
        image_bytes: bytes,
        mime: str,
    ) -> AnalysisResult: ...

    async def generate_image(
        self,
        *,
        prompt: str,
        size: str | None = None,
        style: str | None = None,
    ) -> GeneratedImage: ...
