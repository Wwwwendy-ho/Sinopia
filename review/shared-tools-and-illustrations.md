# Shared tools and portrait empty states

Phone portrait Side view uses one Image tools deck. Drawing/Reference buttons choose the edited image and highlight its window. Mirror, Rotate, Fit, Gray, Contrast and Line up are visible; Auto align and Camera sit beside More tools. File, Paste, Flip, Previous, Hide and Remove are available under More tools. Previous is hidden for Reference; pair alignment actions still operate on the pair. Existing per-pane tools remain available in the other layouts and on wider screens.

Side now opens by default, including after a previously saved layout. Photos, view settings and other preferences restore as before. Portrait-phone Side image bodies are 20% taller (270 px rather than 225 px at 375 px viewport width). The windows do not shrink when More tools is expanded; shorter screens scroll the controls area.

The approved half-finished and completed classical portrait studies are bundled as one transparent WebP sprite, displayed only in empty windows. All layouts use the studies, with a compact horizontal arrangement in short landscape windows. Loaded artwork is never covered by the illustration. Artwork is generated for this interface; no external image service is used at runtime.

Discrete tool edits are saved promptly so an immediate reload does not discard a recent edit.

Validation: 90 empty-layout checks across English, both Chinese variants, Spanish and French; 60 loaded-layout checks plus 90 loaded-image illustration-visibility checks; shared selector, per-image transformations, More expansion, file-picker targeting, default-on-reload and view-setting persistence. The uploaded matching regression pair and the known synthetic scale/rotation pair still auto-align. Uploaded test photos are not included in the repository. Physical Safari/iPhone hardware remains unverified.
