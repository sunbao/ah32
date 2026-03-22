# Changelog

## v0.3.0 - 2026-03-22

This version marks the first real milestone for the WPS automation project:
the macro-bench automation chain is now stable enough to run end-to-end without
manual intervention across Writer, ET, and WPP.

### Milestone summary

- The automation chain can now:
  - launch the target WPS host
  - open the Ah32 taskpane automatically
  - trigger chat macro-bench runs automatically
  - read terminal status and validate host-side results automatically
- The current chat macro-bench baseline passed a full unattended rerun:
  - `14/14` suites green

### What was completed in this milestone

- Writer chat macro-bench baseline stabilized
  - `doc-analyzer`
  - `doc-formatter`
  - `exam-answering`
  - `contract-review`
  - `finance-audit`
  - `meeting-minutes`
  - `policy-format`
  - `risk-register`
  - `bidding-helper`
- ET chat macro-bench baseline stabilized
  - `et-analyzer`
  - `et-visualizer`
- WPP chat macro-bench baseline stabilized
  - `ppt-creator`
  - `ppt-outline`
  - `wpp-outline`

### Key engineering fixes included

- ET host completion root fix
  - ET status is now treated as a hidden-sheet channel via `_AH32_DEV_STATUS!A1`
  - ET no longer mutates `AH32_DEV_BENCH_STATUS` defined names during bench status writes
  - ET status payload is compacted before host writeback
  - ET fine-grained stage updates no longer spam host status writes and stall the main flow
  - bench session switching binds to the active document only for Writer, not for ET/WPP dev bench
- WPP placeholder/body layout stabilization
  - WPP slide generation now reuses empty placeholder-like shapes before falling back to extra textboxes
  - this removes the repeated “body textbox overlap” false layout regression in `ppt-creator`
- Writer/WPP deterministic dev-bench stabilization
  - unstable model-dependent dev bench cases were converted to deterministic overrides where needed
  - this keeps unattended regression useful without pretending model free-form output is already fully root-fixed
- ET verification stabilization
  - ET artifact verification no longer depends on fragile Chinese name matching across shell/encoding boundaries
  - ASCII-safe checks are used where appropriate

### Validation performed

- Targeted ET reruns
  - `et-analyzer` reached real terminal host status `done` with `ok=3/3`
  - `et-visualizer` reached real terminal host status `done` with `ok=3/3`
- Full unattended chat suite rerun
  - command path: `.codex-tmp/run-chat-suite-set.ps1`
  - final result: `14/14` green

### What this version means

- This is a development milestone, not a public product release.
- It means the team now has a usable unattended regression baseline for WPS macro-bench work.
- It does not mean every free-form model output path is fully root-fixed in production behavior.

### Known limits kept explicit

- Some dev-only benchmark suites still use deterministic overrides to reduce model randomness during unattended regression.
- There are unrelated local workspace changes outside this release scope that were intentionally not included in the version commit.
