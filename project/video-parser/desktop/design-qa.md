# Design QA — 影链工坊 Desktop

## Comparison setup

- Reference: approved desktop redesign at 1488 × 1058.
- Implementation: native Tauri WebView at 1240 × 780 CSS pixels (captured at 1.25 device scale on a 1920 × 1080 display).
- Compared in one side-by-side image using the same four-row queue and an active download state.

## Results

- Header, two-column structure, large link input, queue toolbar, four-row queue, settings groups, model cards, and save-path field match the approved hierarchy and visual language.
- The queue remains the only persistent task-status surface.
- The right panel shows only the currently active stage, then removes that progress section after completion. The duplicated completed-download row from the reference was intentionally removed per approval.
- Video, cover, platform text, and subtitles are independently selectable.
- Batch quality and per-item quality controls are visible and usable.
- Installed model state and selection are visible; missing models open the first-use download confirmation.
- The header contains only Update and Models; download storage remains in the main inspector rather than a duplicate settings dialog.
- The Models dialog shows the complete model path, local/API translation choices, encrypted API-key state, and upstream model retrieval without scrolling at the target viewport.
- The Models dialog is 840 px wide; its three Whisper choices use one horizontal row so the API form and footer remain above the taskbar at 125% Windows scaling.
- Queue, inspector, path, button, and model-dialog text was raised to a comfortable 10–14 px range while retaining the approved layout density.
- No horizontal or vertical scrollbar is visible at the target viewport, and the full primary workflow fits without scrolling.
- Long titles truncate without pushing controls out of alignment; missing thumbnails fall back to a real icon.
- Primary, secondary, disabled, selected, downloading, completed, and failed states remain visually distinct.

## Functional visual checks

- Active download: right-side detail progress appears; left queue row also updates without duplicate completion messaging.
- Completed download: right-side detail progress disappears; the matching queue row changes to completed.
- AI extraction and translation: detected language replaces the generic language step while the stage is running.
- AI model selection: a standard dropdown displays every upstream model, switches the active value immediately, and falls back to a manual-name field when the provider cannot return a catalog.
- Empty queue, four-item queue, homepage results, first-use model prompt, and installed-model switching were inspected.

final result: passed
