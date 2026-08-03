"""Frontend-only progress event throttle for ComfyUI.

No backend nodes are registered. The package only exposes the JavaScript
extension in web/js.
"""

WEB_DIRECTORY = "./web/js"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = [
    "WEB_DIRECTORY",
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
