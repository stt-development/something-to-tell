"""Desktop-only loopback API boundary. CORS is not an authorization mechanism."""

from hmac import compare_digest
import re

from starlette.responses import JSONResponse


class DesktopAuthorization:
    def __init__(self, app, *, token: str, allowed_origins: tuple[str, ...]):
        if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
            raise ValueError("desktop_token_invalid")
        self.app = app
        self._authorization = ("Bearer " + token).encode("ascii")
        self._origins = {origin.encode("ascii") for origin in allowed_origins}

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        headers = scope.get("headers", [])
        origins = [value for key, value in headers if key.lower() == b"origin"]
        if len(origins) > 1 or (origins and origins[0] not in self._origins):
            return await JSONResponse({"detail": {"code": "desktop_origin_rejected"}}, status_code=403)(scope, receive, send)
        # Browser preflight has no bearer header and cannot execute domain work.
        if scope["method"] == "OPTIONS" and origins and any(key.lower() == b"access-control-request-method" for key, _ in headers):
            return await self.app(scope, receive, send)
        supplied = [value for key, value in headers if key.lower() == b"authorization"]
        if len(supplied) != 1 or not compare_digest(supplied[0], self._authorization):
            return await JSONResponse({"detail": {"code": "desktop_unauthorized"}}, status_code=401)(scope, receive, send)
        return await self.app(scope, receive, send)
