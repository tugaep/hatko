# Widget API v2

Current guidance for the widget client. It supersedes v1.

Call `widget.init(config)` before any other method. Events flush on demand via
`widget.flush()`, and the client flushes once more on page unload.
