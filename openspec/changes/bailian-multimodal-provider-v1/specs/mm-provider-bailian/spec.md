# Spec — Bailian Multimodal Provider Adapter (v1)

## Summary

Implement Bailian adapter as the default `MultimodalProvider`.

## Configuration

- `AH32_BAILIAN_API_KEY` (required when provider is bailian)
- `AH32_BAILIAN_BASE_URL` (optional)
- `AH32_BAILIAN_VISION_MODEL`
- `AH32_BAILIAN_IMAGE_MODEL`

## Requirements

- Missing/invalid config must fail clearly when strict.
- Must not return base64 bytes in API responses; only `asset_id`.

