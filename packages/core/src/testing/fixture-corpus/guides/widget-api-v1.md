# Widget API v1 (DEPRECATED)

Status: deprecated since March 2026. See "Widget API v2" for current guidance.

Call `widget.init(config)` before any other method. The v1 client batches events
on a fixed thirty-second timer and offers no way to flush them early, which is
why a page that unloads quickly loses its last batch.
