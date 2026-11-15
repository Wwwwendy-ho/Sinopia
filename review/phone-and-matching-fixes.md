# Phone layout, Wipe and automatic matching fixes

- Keep Sinopia visible in phone Overlay mode.
- Use shorter 3:4 image areas in portrait-phone Side mode. Share the header track so a photo counter on one side cannot offset the image tops. Compact empty-state controls remain usable.
- Replace comparison-mode pencil scratches with quiet contact taps.
- Move Wipe's visible control below the image. The divider itself remains draggable and keyboard accessible; the large centre knob is removed.
- Keep matching progress out of the pane headers and apply matches using the current viewport geometry.
- Match a new, unaligned drawing against the current reference rather than a previous drawing. Retakes of aligned work keep the existing alignment, with direct-reference fallback when appropriate; hand-tuned placements are respected. Cancelled work no longer populates the pair cache. Manual movement cancels pending alignment.
- Add a client-only sparse-paper fallback after unsuccessful full-image matching. It finds a localized ink region, searches reference windows, then requires consistent transforms across shifted validation windows. The original full-image matcher and its acceptance thresholds are unchanged. The regional gate combines a high-PSR search with stronger local correlation and repeatability checks; it is not a blanket threshold reduction.

Validation: uploaded drawing/reference pair matches automatically in both load orders. Its relative alignment survives Side/Overlay/Stacked changes on a simulated phone. Uploaded images remain local and are not included in the repository. All 12 unrelated-pair tests were rejected. A known synthetic scale/rotation pair still matches within its expected tolerance. Sixty translated viewport/layout combinations passed; 12 additional empty-phone cases check that upload controls fit. Wipe slider and keyboard interaction, title visibility and equal Side canvas tops passed.

Limits: targeted regression checks are not a guarantee for every drawing. Regional matching takes longer than the original fast path (about 7.5 seconds for the uploaded example in desktop Chromium). Real iPhone hardware and Safari remain unverified. Existing dot alignment remains available when automatic matching cannot establish a reliable result.
