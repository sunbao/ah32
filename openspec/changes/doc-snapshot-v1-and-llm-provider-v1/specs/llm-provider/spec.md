# Spec — LLM Provider Switching (v1)

## Summary

Backend selects LLM provider/model by config with strict behavior by default.

## Requirements

- `AH32_LLM_PROVIDER`: `deepseek` | `openai` | `openai-compatible`
- Strict by default (`AH32_LLM_STRICT=true`)
- When provider is deepseek and strict, require `langchain-deepseek` (no silent fallback).

