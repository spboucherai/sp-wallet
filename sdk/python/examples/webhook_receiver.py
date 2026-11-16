"""Minimal webhook receiver (standard library): verifies X-SPW-Signature over the RAW body, then handles the event.

    SP_WALLET_WEBHOOK_SECRET=… uv run python examples/webhook_receiver.py
"""

from __future__ import annotations

import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from sp_wallet import WebhookVerificationError, construct_webhook_event

SECRET = os.environ.get("SP_WALLET_WEBHOOK_SECRET", "")
SEEN: set[str] = set()  # delivery is at-least-once: deduplicate on the event id (use a durable store in production)


class Handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        raw = self.rfile.read(int(self.headers.get("content-length", "0")))
        try:
            timestamp, signature = self.headers.get("x-spw-timestamp"), self.headers.get("x-spw-signature")
            event = construct_webhook_event(secret=SECRET, timestamp=timestamp, signature=signature, body=raw)
        except WebhookVerificationError:
            self.send_response(400)
            self.end_headers()
            return
        if event["id"] not in SEEN:
            SEEN.add(event["id"])
            print(event["event"], event["id"], event["data"])
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")


if __name__ == "__main__":
    if not SECRET:
        sys.exit("set SP_WALLET_WEBHOOK_SECRET (shown once when the webhook endpoint is created)")
    HTTPServer(("127.0.0.1", int(os.environ.get("PORT", "8787"))), Handler).serve_forever()
