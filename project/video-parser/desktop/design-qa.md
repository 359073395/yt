# 影链工坊 Desktop 1.1 — Design QA

- Source visual truth: `G:\Codex\UserData\.codex\generated_images\01a03d15-f233-7c51-86cd-d19fe173207e\exec-9bf16995-4359-4566-ae90-3b01ef58e9e5.png`
- Implementation screenshot: `G:\GitHub\.codex-tmp\yinglian-v11-qa-final.png`
- Full comparison: `G:\GitHub\.codex-tmp\yinglian-design-qa-full.png`
- Focused inspector comparison: `G:\GitHub\.codex-tmp\yinglian-design-qa-focus.png`
- First-model confirmation state: `G:\GitHub\.codex-tmp\yinglian-v11-model-prompt.png`
- Intended CSS viewport: 1240 × 880 at Windows DPI 120 (1.25 density)
- Source pixels: 1487 × 1058
- Implementation capture pixels: 1568 × 1103, including the native Windows title bar
- Normalization: implementation app content cropped to 1549 × 1055 and resized to 1487 × 1058 for the full comparison
- State: light theme, parsed multi-item list, all items selected, one active download; AI is off until the user consents to the first model download

## Full-view comparison evidence

The implementation preserves the selected design's media-inbox hierarchy: universal paste bar, selectable media rows, right-side mode and output inspector, save location, large download action, and a persistent transfer strip. Major region proportions, neutral palette, orange action color, compact controls, fine dividers, and native desktop density match the source direction.

The source concept mixes individual links and an expanded creator group while its mode control says “单条”. The implementation intentionally keeps the three modes semantically separate and renders every scanned creator item as a normal selectable row. This avoids a contradictory mixed state without changing the approved visual system.

## Focused-region comparison evidence

The inspector comparison verifies mode controls, output checkboxes, AI switch, translation selector, save folder, selection total, estimated size, and primary action. The implementation defaults AI to off because the user added a hard requirement that models must never download before explicit confirmation. Enabling AI opens the separately captured consent modal with model names, sizes, local path, “暂不使用 AI”, and “下载并继续”.

## Required fidelity surfaces

- Fonts and typography: Segoe UI Variable / Microsoft YaHei UI matches the clean Windows product tone. Weights, truncation, and compact labels remain readable at 100% and 125% DPI.
- Spacing and layout rhythm: consistent 6–9 px control radii, 12–22 px section spacing, aligned media rows, stable inspector width, and explicit grid rows prevent layout jumps when notices appear or disappear.
- Colors and visual tokens: warm white surfaces, `#ff6638` primary orange, restrained gray dividers, and neutral text closely follow the selected mock while preserving accessible contrast.
- Image quality and asset fidelity: real remote media thumbnails use `object-fit: cover`; standard interface actions use the existing tree-shaken icon library. No placeholder CSS artwork, emoji, or handcrafted SVG assets are used.
- Copy and content: Chinese labels follow the approved flow and distinguish 单条、多链接、博主主页, output choices, model consent, folder selection, and task state.

## Comparison history

1. Initial implementation finding — P2: the 1320 × 840 window was wider than the selected design, and the optional notice row allowed the activity area to consume excess height.
   - Fix: changed the default window to 1240 × 880, increased the minimum height to 720, and assigned header, notice, body, and activity bar to explicit grid rows.
   - Post-fix evidence: `G:\GitHub\.codex-tmp\yinglian-v11-qa-final.png`; the inspector is fully visible, the media list retains useful density, and the transfer bar stays compact.
2. Initial implementation finding — P2: the default video checkbox appeared disabled rather than selected.
   - Fix: retained video as a controlled required output while restoring the same orange selected appearance as other output controls.
   - Post-fix evidence: focused inspector comparison shows consistent selected styling.

## Findings

No actionable P0, P1, or P2 visual mismatches remain.

## Follow-up polish

- P3: the source concept shows six visible items and an inline creator gallery; the implementation shows four larger rows at the real 1240 × 880 desktop viewport and scrolls additional items. This is an intentional density and semantic trade-off.
- P3: the implementation keeps the native Windows title bar, which is absent from the generated concept image.

## Verification notes

- The real Tauri window was captured in both the populated-list state and the first-model confirmation state.
- Frontend TypeScript/Vite build, Vitest, Rust check, Rust clippy with warnings denied, and production dependency audit passed.
- The Windows Computer Use runtime was unavailable, so pointer automation was not used. The implementation and source were still directly captured and compared from the running Tauri application.

final result: passed
