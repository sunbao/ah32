# Spec — Multimodal Provider (v1)

## Summary

Define the internal multimodal provider contract used by the agent runtime to:
- analyze an input image (image understanding)
- generate an output image (image generation)

## Requirements

- Provider must expose:
  - `analyze_image(prompt, image_bytes, mime, opts) -> text (+ optional structured)`
  - `generate_image(prompt, opts) -> asset_id` (bytes stored in Asset store)
- Provider selection is env-driven and strict by default:
  - `AH32_MM_PROVIDER` default `bailian`
  - `AH32_MM_STRICT` default `true`
- No silent downgrade to other providers when strict.
- Observability: log provider/model, sizes, durations, trace_id; never log bytes/prompt content.

## Non-goals

- Audio/video
- Persisting generated assets into RAG

