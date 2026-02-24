# AH32 (Aha)

[English](README.en.md) | [中文](README.md)

AH32 (product name: **Aha**) is a local-first office assistant for **WPS Office**. Inspired by the overall architecture and interaction patterns of *VibeCoding*, it helps users extract value from everyday office documents (summarization, alignment, search, structured notes, etc.) through **chat + executable actions** (default: writeback via Plan JSON).

Note: due to historical reasons, the backend Python package directory remains `src/ah32/` (import path is still `ah32`).

## Core Capabilities (incl. Bidding/Tendering)

- **Skill-based scenarios**: Skills for different business scenarios (e.g., bidding docs analysis, compliance checks, meeting minutes, PPT/spreadsheet assistance). A router selects the best skill automatically or via user intent.
- **Bidding/tendering (example: `bidding-helper`)**: Generates structured outputs that can be used directly in the workflow, such as compliance/deviation matrices, clarification questions, risks & recommendations, and milestone timelines.
- **RAG (retrieval augmentation)**: Knowledge bases (contracts, cases, templates, policies) can come from user uploads/imports, or from URL ingestion into the RAG library for later retrieval in conversations.
- **Missing-library awareness**: If a scenario relies on RAG but retrieval returns no hits, the system explicitly reports "no hits / library needs data" and guides the user to upload materials or provide URLs for ingestion.
- **Source display policy**: By default, sources/URLs are not shown in the main body or writeback content to avoid messing up formatting; sources are appended only when users explicitly ask for "source/citation/link".

## Download & Install

We recommend distributing via GitHub Releases (plugin zip + backend package). Packaging details: `PACKAGING.md`.

## Contact

- Prefer GitHub Issues (please include screenshots/logs/repro steps if possible).
- For quick contact / collaboration: WeChat `abaokaimen` (note: AH32/GitHub).

### Install the WPS Plugin (connect to a remote backend)

1) Download `Ah32WpsPlugin.zip` and unzip it
2) Run the install script (set `ApiBase` to your backend URL):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-wps-plugin.ps1 `
  -PluginSource .\wps-plugin `
  -ApiBase http://<YOUR_BACKEND_HOST>:5123 `
  -ApiKey <YOUR_KEY>
```

3) Restart WPS

Security & privacy: `SECURITY.md`.

## Repository Layout

Only the core directories are listed here.

- `src/ah32/`: backend (FastAPI; import path `ah32`)
  - `server/`: HTTP API (entry: `python -m ah32.server.main`)
  - `agents/`: chat/execution agent logic (planning, tool-use, writeback pipeline)
  - `skills/`: SkillRegistry/SkillRouter (hot-loaded from runtime `skills/`)
  - `services/`: prompts, @ references, memory/RAG, etc.
  - `telemetry/`: observability and events
  - `dev/`: dev/bench/debug (OFF by default; `/dev/*` only when `AH32_ENABLE_DEV_ROUTES=true`)
- `ah32-ui-next/`: frontend (Vue 3 + TypeScript + Vite) + WPS add-in
  - `src/`: frontend code
  - `src/dev/`, `src/components/dev/`: MacroBench & debug panels (`VITE_ENABLE_DEV_UI=true`)
  - `manifest.xml` / `ribbon.xml` / `taskpane.html`: add-in entry/config
  - `wps-plugin/`: build output (runtime load dir; usually not committed)
  - `install-wps-plugin.ps1` / `uninstall-wps-plugin.ps1`: Windows install/uninstall scripts
- `skills/`: runtime skills directory (hot-loaded by default)
- `schemas/`: JSON schemas (e.g., `ah32.skill.v1`, `ah32.styleSpec.v1`)
- `scripts/`: dev/packaging scripts
- `installer/`: installer assets and scripts (multi-platform)

Do NOT commit runtime/generated folders (may be large or contain secrets): `storage/`, `logs/`, `.venv/`, `ah32-ui-next/node_modules/`, `ah32-ui-next/wps-plugin/`, `dist/`, `build/`, `_release/`, `.env`.

## Dev Quick Start

Backend:

```bash
python -m venv .venv
# Windows:
.venv\\Scripts\\activate
# macOS/Linux:
# source .venv/bin/activate

pip install -e ".[dev]"
cp .env.example .env   # Windows: copy .env.example .env

python -m ah32.server.main
```

Frontend (WPS TaskPane):

```bash
cd ah32-ui-next
npm install
npm run dev
```

Default backend address: `http://127.0.0.1:5123`

## Packaging / Release

See `PACKAGING.md`.

